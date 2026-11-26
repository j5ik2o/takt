/**
 * Stops laps that make no progress: `max_visits` caps how many times one
 * engine completes a step, and `stop_on_repeated_verdict` stops when a step
 * matches the same rule as on its previous visit.
 *
 * A visit counts once it ends in a transition. Retrying the same visit
 * (user input after blocked, a failed quality gate, a rate-limit fallback)
 * re-enters the step without completing it, so it does not use the limit.
 *
 * Counts live in this engine only. They are not derived from
 * `state.stepIterations`, whose keys are scoped by the workflow-call stack and
 * which a resume restores to the visit being retried.
 */

import type { WorkflowStep } from '../../models/types.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';

export class StepLoopGuard {
  private readonly completedVisits = new Map<string, number>();
  private readonly lastRuleIndex = new Map<string, number>();

  /** Returns the stop reason when the step already completed `max_visits` visits. */
  checkEntry(step: WorkflowStep): string | undefined {
    const completed = this.completedVisits.get(step.name) ?? 0;
    if (step.maxVisits === undefined || completed < step.maxVisits) {
      return undefined;
    }
    return `Visit limit reached: step "${step.name}" already completed ${completed} times (max_visits: ${step.maxVisits}); stopping instead of another lap.`;
  }

  /**
   * Counts one completed visit and records its verdict. Returns the stop reason
   * when the verdict repeats the step's previous one under `stop_on_repeated_verdict`.
   * `matchedRuleIndex` is undefined for terminal transitions, which are never compared.
   */
  recordCompletion(step: WorkflowStep, matchedRuleIndex: number | undefined): string | undefined {
    this.completedVisits.set(step.name, (this.completedVisits.get(step.name) ?? 0) + 1);
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
