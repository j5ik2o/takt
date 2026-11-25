/**
 * Stops laps that make no progress: `max_visits` caps how many times one
 * engine enters a step, and `stop_on_repeated_verdict` stops when a step
 * matches the same rule as on its previous visit.
 *
 * Counts live in this engine only. They are not derived from
 * `state.stepIterations`, whose keys are scoped by the workflow-call stack and
 * which a resume restores to the visit being retried.
 */

import type { WorkflowStep } from '../../models/types.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';

export class StepLoopGuard {
  private readonly visits = new Map<string, number>();
  private readonly lastRuleIndex = new Map<string, number>();

  /** Counts one entry into the step; returns the stop reason instead when the limit is already reached. */
  enter(step: WorkflowStep): string | undefined {
    const completed = this.visits.get(step.name) ?? 0;
    if (step.maxVisits !== undefined && completed >= step.maxVisits) {
      return `Visit limit reached: step "${step.name}" already ran ${completed} times (max_visits: ${step.maxVisits}); stopping instead of another lap.`;
    }
    this.visits.set(step.name, completed + 1);
    return undefined;
  }

  /** Records the verdict; returns the stop reason when it repeats the step's previous one. */
  recordVerdict(step: WorkflowStep, matchedRuleIndex: number | undefined): string | undefined {
    if (step.stopOnRepeatedVerdict !== true || matchedRuleIndex === undefined) {
      return undefined;
    }
    const previous = this.lastRuleIndex.get(step.name);
    this.lastRuleIndex.set(step.name, matchedRuleIndex);
    if (previous !== matchedRuleIndex) {
      return undefined;
    }
    const rule = step.rules?.[matchedRuleIndex];
    const verdict = rule === undefined ? `rule #${matchedRuleIndex}` : formatWorkflowRuleCondition(rule.condition);
    return `No progress: step "${step.name}" returned the same verdict "${verdict}" twice in a row; stopping instead of another lap.`;
  }
}
