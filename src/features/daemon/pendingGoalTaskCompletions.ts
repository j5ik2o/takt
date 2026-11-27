import { DaemonPersistedFiles, inspectDeletionOwner } from '../../infra/daemon/persistedFiles.js';
import { hasCode } from '../../infra/daemon/privateFile.js';
import { isGoalFinished } from '../../infra/goals/activity.js';
import type { PendingGoalTaskCompletion } from '../../infra/task/taskStateReader.js';
import type { WatchGoal } from './watchers/goalReader.js';

export type PendingGoalTaskCompletionWithRepository = PendingGoalTaskCompletion & {
  repositoryDirectory: string;
};

/**
 * Resends the pending goal task completions the daemon found in tasks.yaml (#170), one by one:
 * a finished or deleted goal only loses its mark, an active or paused goal gets its inbox
 * record first and its mark cleared after. One failure never stops the remaining completions.
 */
export async function publishPendingGoalTaskCompletions(
  configDirectory: string,
  completions: readonly PendingGoalTaskCompletionWithRepository[],
  readGoal: (repositoryDirectory: string, goalId: string) => Promise<Pick<WatchGoal, 'status' | 'executionStatus'>>,
  onError: (error: unknown) => void,
): Promise<void> {
  const files = new DaemonPersistedFiles(configDirectory);
  for (const completion of completions) {
    try {
      if (completion.deletion !== undefined && (await inspectDeletionOwner(completion.deletion)) !== 'dead') {
        // A live owner finishes or cancels the deletion first; an unknown owner is left
        // alone (and already reported by the watch source) instead of being waited on.
        continue;
      }
      const identity = {
        goalId: completion.goalId, taskName: completion.name, status: completion.status,
        ...(completion.runSlug === undefined ? {} : { runSlug: completion.runSlug }),
        ...(completion.executionId === undefined ? {} : { executionId: completion.executionId }),
      };
      let goal: Pick<WatchGoal, 'status' | 'executionStatus'>;
      try {
        goal = await readGoal(completion.repositoryDirectory, completion.goalId);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) {
          await files.markGoalTaskCompletionPublished(completion.repositoryDirectory, identity);
          continue;
        }
        throw error;
      }
      if (isGoalFinished(goal)) {
        await files.markGoalTaskCompletionPublished(completion.repositoryDirectory, identity);
        continue;
      }
      await files.saveGoalTaskCompletion(completion.repositoryDirectory, {
        goalId: completion.goalId, taskName: completion.name,
        ...(completion.runSlug === undefined ? {} : { runSlug: completion.runSlug }),
        ...(completion.executionId === undefined ? {} : { executionId: completion.executionId }),
        result: completion.completion,
      });
      await files.markGoalTaskCompletionPublished(completion.repositoryDirectory, identity);
    } catch (error) {
      onError(error);
    }
  }
}
