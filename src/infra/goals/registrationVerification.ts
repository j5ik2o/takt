import { resolveManagerConfig } from '../config/managerConfig.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../config/formalSpecConfig.js';
import {
  cleanupFormalSpecVerificationArtifacts,
  runFormalSpecVerification,
  type FormalSpecStageResult,
  type FormalSpecVerificationResult,
} from '../formal-spec/formalSpecVerifier.js';
import { formatCodeBlock } from '../../shared/utils/markdown.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { GoalStore } from './store.js';
import { appendGoalWorkLog } from './workLog.js';
import type { Goal } from './schema.js';

export function initialRegistrationVerification(cwd: string, specifications: Goal['specifications']): Goal['registrationVerification'] {
  if (specifications?.quint === undefined && specifications?.alloy === undefined) return undefined;
  return { status: resolveManagerConfig(cwd).verifyOnRegister && resolveFormalSpecConfigurationWithoutPrompt(cwd).mode
    ? 'pending' : 'not_required' };
}

function stageSummary(language: string, result: FormalSpecStageResult): string {
  const message = result.message === undefined ? '' : `: ${truncateUtf8(result.message, 1_024).value}`;
  return `${language}: ${result.status}${message}`;
}

function verificationSummary(specifications: Goal['specifications'], result: FormalSpecVerificationResult): string {
  return [
    `Formal specification verification: ${result.verdict}`,
    ...(specifications?.quint === undefined ? [] : [stageSummary('Quint', result.quint)]),
    ...(specifications?.alloy === undefined ? [] : [stageSummary('Alloy', result.alloy)]),
    ...(result.message === undefined ? [] : [truncateUtf8(result.message, 2_048).value]),
  ].join('\n');
}

async function runRegistrationVerification(cwd: string, specifications: Goal['specifications'], signal: AbortSignal | undefined): Promise<FormalSpecVerificationResult> {
  const configuration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  const blocks = [
    ...(specifications?.quint === undefined ? [] : [formatCodeBlock(specifications.quint, 'quint')]),
    ...(specifications?.alloy === undefined ? [] : [formatCodeBlock(specifications.alloy, 'alloy')]),
  ];
  return runFormalSpecVerification(blocks.join('\n\n'), cwd, {
    abortSignal: signal, modelCheckTimeoutSeconds: configuration.modelCheckTimeoutSeconds,
  });
}

export class GoalRegistrationVerificationError extends Error {
  readonly code = 'registration_verification';
  readonly verdict: 'failed' | 'error';

  constructor(verdict: 'failed' | 'error', summary: string) {
    super(summary);
    this.name = 'GoalRegistrationVerificationError';
    this.verdict = verdict;
  }
}

function stageFailureSummary(language: string, result: FormalSpecStageResult): string {
  const message = result.message === undefined ? '' : `: ${truncateUtf8(result.message, 96).value}`;
  return `${language}: ${result.status}${message}`;
}

// The manager conversation displays operation failures with the reason
// truncated to 500 width units, and a failed registration leaves no saved
// goal or work log to recover the details from. The failure summary therefore
// carries only the verdict, one short line per stage, a short overall
// message, and the retained artifact directory, sized to survive that
// truncation. The full diagnostics remain in the retained artifacts.
function registrationFailureSummary(specifications: Goal['specifications'], result: FormalSpecVerificationResult): string {
  return [
    `Formal specification verification: ${result.verdict}`,
    ...(specifications?.quint === undefined ? [] : [stageFailureSummary('Quint', result.quint)]),
    ...(specifications?.alloy === undefined ? [] : [stageFailureSummary('Alloy', result.alloy)]),
    ...(result.message === undefined ? [] : [truncateUtf8(result.message, 64).value]),
    ...(result.artifacts === undefined ? [] : [`Verification artifacts: ${result.artifacts.runDirectory}`]),
  ].join('\n');
}

export async function verifyGoalSpecificationsForRegistration(
  cwd: string,
  specifications: Goal['specifications'],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runRegistrationVerification(cwd, specifications, signal);
  try {
    if (result.verdict !== 'passed') {
      throw new GoalRegistrationVerificationError(result.verdict, registrationFailureSummary(specifications, result));
    }
    return verificationSummary(specifications, result);
  } finally {
    cleanupFormalSpecVerificationArtifacts(result);
  }
}

export async function verifyRegisteredGoal(cwd: string, goal: Goal, signal: AbortSignal | undefined): Promise<Goal> {
  const specifications = goal.specifications;
  if (specifications?.quint === undefined && specifications?.alloy === undefined) return goal;
  if (goal.registrationVerification?.status === 'not_required') return goal;
  const store = new GoalStore(cwd);
  const notRequired = () => store.update(goal.id, (current) => ({ ...current, registrationVerification: { status: 'not_required' } }));
  if (!resolveManagerConfig(cwd).verifyOnRegister) return notRequired();
  const configuration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  if (!configuration.mode) return notRequired();
  const result = await runRegistrationVerification(cwd, specifications, signal);
  try {
    const summary = verificationSummary(specifications, result);
    return await store.update(goal.id, (current) => {
      const updated = appendGoalWorkLog(current, { summary });
      return { ...updated, registrationVerification: { status: 'completed', verdict: result.verdict, workLogId: updated.workLog.at(-1)!.id } };
    });
  } finally {
    cleanupFormalSpecVerificationArtifacts(result);
  }
}
