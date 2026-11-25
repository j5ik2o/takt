/**
 * Stops laps that make no progress: `max_visits` caps how many times one
 * engine enters a step, and `stop_on_repeated_verdict` stops when a step
 * matches the same rule as on its previous visit.
 */

import type { WorkflowStep } from '../../models/types.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';

export function stepVisitLimitReason(step: WorkflowStep, completedVisits: number): string | undefined {
  if (step.maxVisits === undefined || completedVisits < step.maxVisits) {
    return undefined;
  }
  return `Visit limit reached: step "${step.name}" already ran ${completedVisits} times (max_visits: ${step.maxVisits}); stopping instead of another lap.`;
}

export class StepVerdictHistory {
  private readonly lastRuleIndex = new Map<string, number>();

  /** Records the verdict; returns the stop reason when it repeats the step's previous one. */
  recordAndCheck(step: WorkflowStep, matchedRuleIndex: number | undefined): string | undefined {
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
