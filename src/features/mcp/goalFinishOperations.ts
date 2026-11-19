import type { Goal } from '../../infra/goals/schema.js';
import {
  fetchGoalIntegrationBranchSha, isGoalContentIncluded, resolveGoalBranchSha, resolveGoalRemoteBranchSha,
} from '../../infra/goals/git-command.js';
import { GoalStore } from '../../infra/goals/store.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { TaskRunner } from '../../infra/task/runner.js';
import type { TaskState } from '../../infra/task/types.js';
import type { McpOperationDependencies } from './operations.js';
import { goalWrite } from './goalWrite.js';
import { integrationSummary } from './goalResponse.js';
import type { FinishGoalInput } from './goalFinishSchemas.js';

const finishInstructions = [
  'This goal was finished from an aborted state. No further work or completion steps are needed.',
];

type ChangeSummary = NonNullable<Goal['completion']>['changeSummary'];

const emptyChangeSummary: ChangeSummary = {
  filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false,
};

function hasCompletedResult(task: TaskState): boolean {
  return task.status === 'completed' || task.status === 'pr_failed'
    || task.completion?.sha !== undefined || task.completion?.workflowResult === 'completed';
}

/**
 * An aborted goal can only be finished while no live work would be discarded.
 * Running work remains the responsibility of its own operations.
 */
function assertAbortedGoalFinishable(goal: Goal, tasks: readonly TaskState[]): void {
  if (goal.executionStatus !== 'aborted') {
    throw new Error('Goal is not aborted. Only an aborted goal can be finished.');
  }
  if (goal.status !== 'created' && goal.status !== 'awaiting_merge') {
    throw new Error('Only a created or awaiting_merge goal can be finished.');
  }
  const own = tasks.filter((task) => task.goalId === goal.id);
  if (own.some((task) => task.status === 'running')) {
    throw new Error('A task is still running for this goal. Stop it before finishing the goal.');
  }
}

function nextFinishedGoal(goal: Goal, reason: string, targetSha: string): Goal {
  const completion = goal.completion === undefined
    ? {
      goalBranch: goal.branch, goalSha: targetSha, targetBranch: goal.integrationBranch, targetSha,
      summary: reason, changeSummary: emptyChangeSummary, instructions: finishInstructions,
    }
    : { ...goal.completion, targetSha };
  return { ...goal, status: 'completed', completion };
}

async function assertNoUnintegratedResult(cwd: string, goal: Goal, tasks: readonly TaskState[],
  signal: AbortSignal): Promise<void> {
  const results = tasks.filter((task) => task.goalId === goal.id && hasCompletedResult(task));
  if (results.length === 0) return;
  const integratedSha = await resolveIntegratedSha(cwd, goal, signal);
  for (const task of results) {
    const sha = task.completion?.sha;
    if (sha !== undefined && await isGoalContentIncluded(cwd, sha, integratedSha, signal)) continue;
    throw new Error('This goal has an unintegrated result. Integrate or discard it before finishing the goal.');
  }
}

// 未取り込み判定は統合先ブランチ先端が正本。ゴールブランチ先端だけを見ると、
// ゴールブランチにしか取り込まれていない結果を「取り込み済み」と誤判定する。
// 解決元は PR の有無で選ぶ（正本 resolveCompletionTargetSha と同じ）。PR 保存済みでは
// ローカル ref を持たない統合先があり得るため、ローカル解決を fetch より先に行わない。
// fetch 失敗時のみローカル先端を解決し、remote 追跡参照と一致する場合だけ代替先端として
// 採用する。確認できない場合は例外を伝播して保存せず失敗させる。
async function resolveIntegratedSha(cwd: string, goal: Goal, signal: AbortSignal): Promise<string> {
  if (goal.pullRequest === undefined) return resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
  try {
    return await fetchGoalIntegrationBranchSha(cwd, goal.integrationBranch, signal);
  } catch {
    signal.throwIfAborted();
    const localSha = await resolveGoalBranchSha(cwd, goal.integrationBranch, signal);
    const remoteSha = await resolveGoalRemoteBranchSha(cwd, goal.integrationBranch, signal);
    if (remoteSha !== localSha) {
      throw new Error('The integration branch could not be refreshed and the local reference may be stale.');
    }
    return localSha;
  }
}

export function finishTaktAbortedGoal(input: FinishGoalInput, deps: McpOperationDependencies, signal: AbortSignal) {
  return goalWrite(input, deps, signal, async () => {
    const store = new GoalStore(input.cwd);
    const previous = await store.get(input.goalId);
    signal.throwIfAborted();
    const runner = new TaskRunner(input.cwd);
    assertAbortedGoalFinishable(previous, runner.listTaskStateItems());
    const targetSha = await resolveGoalBranchSha(input.cwd, previous.branch, signal);
    signal.throwIfAborted();
    await assertNoUnintegratedResult(input.cwd, previous, runner.listTaskStateItems(), signal);
    signal.throwIfAborted();
    const saved = await store.update(input.goalId, (current) => {
      signal.throwIfAborted();
      assertAbortedGoalFinishable(current, runner.listTaskStateItems());
      return appendGoalWorkLog(nextFinishedGoal(current, input.reason, targetSha), { summary: input.reason });
    });
    return integrationSummary({ goal: saved, workLogEntryId: saved.workLog.at(-1)!.id, targetSha });
  }, 'Goal finish failed', 'finish_aborted');
}
