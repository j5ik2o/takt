import { GoalStore } from './store.js';
import { GoalIdSchema, type Goal, type GoalExecutionOrigin } from './schema.js';
import { transitionGoalExecution } from './state.js';
import { withdrawPendingGoalQuestions } from './questions.js';
import { deleteGoalEvents, saveManagerEvent } from './events.js';
import { GoalExecutionSavedError } from './goalExecutionSavedError.js';

export async function setGoalExecutionStatus(
  cwd: string, goalId: string, executionStatus: Goal['executionStatus'], signal: AbortSignal,
  // 発信元を持たない呼び出しは、人の操作として扱わない。
  origin?: GoalExecutionOrigin,
): Promise<Goal> {
  GoalIdSchema.parse(goalId);
  const store = new GoalStore(cwd);
  const previous = await store.get(goalId);
  signal.throwIfAborted();
  let savedGoal: Goal | undefined;
  let saved = false;
  let goal: Goal;
  try {
    goal = await store.update(goalId, (current) => {
      const transitioned = transitionGoalExecution(current, executionStatus);
      const next = executionStatus === 'aborted'
        ? withdrawPendingGoalQuestions(transitioned, 'Goal was aborted', new Date().toISOString()) : transitioned;
      savedGoal = next;
      return next;
    }, () => { saved = true; });
  } catch (error) {
    if (!saved || savedGoal === undefined) throw error;
    // #169: goal.json is already saved; only releasing a lock afterwards failed.
    // The steps after the save still run, and the saved goal travels with the
    // error so the caller can run its own steps after the save as well.
    const followUpErrors: unknown[] = [];
    try {
      if (executionStatus === 'aborted') deleteGoalEvents(cwd, goalId);
      if (executionStatus === 'active' && previous.executionStatus === 'paused') {
        saveManagerEvent(cwd, { kind: 'resumed', goalId, ...(origin === undefined ? {} : { origin }) });
      }
    } catch (followUpError) {
      followUpErrors.push(followUpError);
    }
    throw new GoalExecutionSavedError(savedGoal, error, followUpErrors);
  }
  if (executionStatus === 'aborted') deleteGoalEvents(cwd, goalId);
  if (executionStatus === 'active' && previous.executionStatus === 'paused') {
    saveManagerEvent(cwd, { kind: 'resumed', goalId, ...(origin === undefined ? {} : { origin }) });
  }
  return goal;
}
