import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from './git.js';
import { GoalCreateInputSchema, GoalIdSchema, GoalSchema, type Goal, type GoalCreateInput } from './schema.js';
import { GoalStore } from './store.js';
import { readManagerEvents, saveManagerEvent } from './events.js';
import { runGoalGit } from './git-command.js';
import { TaskRunner } from '../task/runner.js';
import { getGlobalConfigDir } from '../config/paths.js';
import { registerProject } from '../config/global/projectRegistry.js';
import { FileEventStore } from '../daemon/eventStore.js';
import {
  GoalRegistrationRecoveryError, initialRegistrationVerification, needsRegistrationReverification,
  reverifyRegisteredGoal, verifyGoalSpecificationsForRegistration,
} from './registrationVerification.js';
import { appendGoalWorkLog } from './workLog.js';

export async function createGoal(input: GoalCreateInput, signal?: AbortSignal): Promise<Goal> {
  signal?.throwIfAborted();
  input = GoalCreateInputSchema.parse(input);
  const store = new GoalStore(input.cwd);
  store.assertAbsent(input.id);
  const registrationVerification = initialRegistrationVerification(input.cwd, input.specifications);
  let verificationSummary: string | undefined;
  if (registrationVerification?.status === 'pending') {
    verificationSummary = await verifyGoalSpecificationsForRegistration(input.cwd, input.specifications, signal);
  }
  signal?.throwIfAborted();
  await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: input.cwd, command: 'manager', managerUsed: true });
  signal?.throwIfAborted();
  const { commit, ...branches } = await prepareGoalBranch(input.cwd, input.id, input.startBranch, input.integrationBranch, signal);
  signal?.throwIfAborted();
  let goal = GoalSchema.parse({
    id: input.id, createdAt: new Date().toISOString(), objective: input.objective, outOfScope: input.outOfScope,
    acceptanceCriteria: input.acceptanceCriteria, constraints: input.constraints,
    ...(input.specifications === undefined ? {} : { specifications: input.specifications }),
    ...(registrationVerification === undefined ? {} : { registrationVerification }),
    workLog: [], mode: 'local', status: 'created', executionStatus: 'active',
    acceptanceCriteriaVersion: 1, ...branches,
  });
  if (verificationSummary !== undefined) {
    const withVerification = appendGoalWorkLog(goal, { summary: verificationSummary });
    goal = GoalSchema.parse({
      ...withVerification,
      registrationVerification: { status: 'completed', verdict: 'passed', workLogId: withVerification.workLog.at(-1)!.id },
    });
  }
  createGoalBranch(input.cwd, goal.branch, commit);
  try { await store.create(goal); }
  catch (error) {
    removeGoalBranch(input.cwd, goal.branch, commit);
    throw error;
  }
  saveManagerEvent(input.cwd, { kind: 'registered', goalId: goal.id });
  return goal;
}

export { GoalRegistrationRecoveryError };

async function hasGoalRegistrationBranch(cwd: string, id: string, signal: AbortSignal | undefined): Promise<boolean> {
  const refs = await runGoalGit(cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/takt/*-goal-${id.slice(0, 8)}`], 1024, signal);
  return refs.truncated || refs.output.length > 0;
}

export async function hasGoalRegistrationArtifacts(cwd: string, id: string): Promise<boolean> {
  GoalIdSchema.parse(id);
  if (new GoalStore(cwd).find(id) !== undefined) return true;
  return hasGoalRegistrationBranch(cwd, id, undefined);
}

/** Retries a reserved registration. It never runs the verifier for a goal that is already saved. */
export function registerReservedGoal(input: GoalCreateInput, signal?: AbortSignal): Promise<Goal> {
  return recoverReservedGoal(input, signal, false);
}

/** The explicit recovery: also re-runs an interrupted or unpassed verification of the saved goal. */
export function reverifyReservedGoal(input: GoalCreateInput, signal?: AbortSignal): Promise<Goal> {
  return recoverReservedGoal(input, signal, true);
}

async function recoverReservedGoal(input: GoalCreateInput, signal: AbortSignal | undefined, reverify: boolean): Promise<Goal> {
  signal?.throwIfAborted();
  input = GoalCreateInputSchema.parse(input);
  const store = new GoalStore(input.cwd);
  const existing = store.find(input.id);
  if (existing !== undefined) {
    const assertMatchingReservation = (existing: Goal): void => {
      if (existing.objective !== input.objective
        || JSON.stringify(existing.outOfScope) !== JSON.stringify(input.outOfScope)
        || JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(input.acceptanceCriteria)
        || JSON.stringify(existing.specifications) !== JSON.stringify(input.specifications)
        || JSON.stringify(existing.constraints) !== JSON.stringify(input.constraints)
        || (input.startBranch !== undefined && existing.startBranch !== input.startBranch)
        || (input.integrationBranch !== undefined && existing.integrationBranch !== input.integrationBranch)) {
        throw new GoalRegistrationRecoveryError('Reserved goal conflicts with the approved proposal');
      }
    };
    assertMatchingReservation(existing);
    if (!readManagerEvents(input.cwd).some(({ event }) => event.goalId === input.id && event.kind === 'registered')
      && existing.workLog.length === 0 && existing.status === 'created'
      && !new TaskRunner(input.cwd).listTaskStateItems().some((task) => task.goalId === input.id)
      && !await new FileEventStore(getGlobalConfigDir()).hasGoalRegistration(input.cwd, input.id)) {
      throw new GoalRegistrationRecoveryError('Goal exists, but registration event delivery cannot be confirmed');
    }
    const latest = store.find(input.id);
    if (latest === undefined) throw new GoalRegistrationRecoveryError('Reserved goal no longer exists');
    assertMatchingReservation(latest);
    if (!needsRegistrationReverification(latest)) return latest;
    if (!reverify) throw new GoalRegistrationRecoveryError('Reserved goal verification has not passed');
    signal?.throwIfAborted();
    return reverifyRegisteredGoal(input.cwd, latest, signal);
  }
  signal?.throwIfAborted();
  if (await hasGoalRegistrationBranch(input.cwd, input.id, signal)) {
    throw new GoalRegistrationRecoveryError('A branch for this reservation requires explicit reconciliation');
  }
  // Re-verification recovers a saved goal. Creating one stays with the plain approval.
  if (reverify) throw new GoalRegistrationRecoveryError('Reserved goal does not exist, so there is nothing to verify again');
  return createGoal(input, signal);
}
