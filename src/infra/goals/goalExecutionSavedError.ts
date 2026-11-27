import type { Goal } from './schema.js';

/**
 * goal.json was saved, but releasing a lock afterwards failed (#169). Carries the
 * saved goal so a caller can run its own steps after the save (an abort cannot be
 * repeated once the transition is saved) and then report the release error.
 * `followUpErrors` holds failures of the steps after the save that already ran
 * inside `setGoalExecutionStatus`.
 */
export class GoalExecutionSavedError extends Error {
  readonly goal: Goal;
  readonly releaseError: unknown;
  readonly followUpErrors: readonly unknown[];

  constructor(goal: Goal, releaseError: unknown, followUpErrors: readonly unknown[] = []) {
    super(
      releaseError instanceof Error ? releaseError.message : String(releaseError),
      { cause: releaseError },
    );
    this.name = 'GoalExecutionSavedError';
    this.goal = goal;
    this.releaseError = releaseError;
    this.followUpErrors = followUpErrors;
  }
}

/** Throws the release error, aggregated with any follow-up failures (reconcileLostRun shape). */
export function throwGoalExecutionSavedError(
  saved: GoalExecutionSavedError,
  followUpErrors: readonly unknown[],
): never {
  const failures = [...saved.followUpErrors, ...followUpErrors];
  if (failures.length > 0) {
    throw new AggregateError(
      [...failures, saved.releaseError],
      'Goal execution was saved, but a follow-up step and the lock release both failed',
    );
  }
  throw saved.releaseError;
}
