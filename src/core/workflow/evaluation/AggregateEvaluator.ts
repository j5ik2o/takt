/**
 * Aggregate condition evaluator for parallel workflow movements
 *
 * Evaluates all()/any() aggregate conditions against sub-movement results.
 */

import type { WorkflowMovement, WorkflowState } from '../../models/types.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('aggregate-evaluator');

/**
 * Evaluates aggregate conditions (all()/any()) for parallel parent movements.
 *
 * For each aggregate rule, checks the matched condition text of sub-movements:
 * - all("X"): true when ALL sub-movements have matched condition === X
 * - all("A", "B"): true when 1st sub-movement matches "A" AND 2nd sub-movement matches "B" (order-based)
 * - any("X"): true when at least ONE sub-movement has matched condition === X
 * - any("A", "B"): true when at least ONE sub-movement matches "A" OR "B"
 *
 * Edge cases per spec:
 * - Sub-movement with no matched rule: all() → false, any() → skip that sub-movement
 * - No sub-movements (0 件): both → false
 * - Non-parallel movement: both → false
 * - all("A", "B") with wrong number of sub-movements: false (logged as error)
 */
export class AggregateEvaluator {
  constructor(
    private readonly step: WorkflowMovement,
    private readonly state: WorkflowState,
  ) {}

  /**
   * Evaluate aggregate conditions.
   * Returns the 0-based rule index in the movement's rules array, or -1 if no match.
   */
  evaluate(): number {
    if (!this.step.rules || !this.step.parallel || this.step.parallel.length === 0) return -1;

    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (!rule.isAggregateCondition || !rule.aggregateType || !rule.aggregateConditionText) {
        continue;
      }

      const subMovements = this.step.parallel;
      const targetCondition = rule.aggregateConditionText;

      if (rule.aggregateType === 'all') {
        // Multiple conditions: order-based matching (1st sub-movement matches 1st condition, etc.)
        if (Array.isArray(targetCondition)) {
          if (targetCondition.length !== subMovements.length) {
            log.error('all() condition count mismatch', {
              movement: this.step.name,
              conditionCount: targetCondition.length,
              subMovementCount: subMovements.length,
            });
            continue;
          }
          const allMatch = subMovements.every((sub, idx) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            const expectedCondition = targetCondition[idx];
            if (!expectedCondition) return false;
            return matchedRule?.condition === expectedCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched (multi-condition)', { movement: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: all sub-movements must match the same condition
          const allMatch = subMovements.every((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return matchedRule?.condition === targetCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched', { movement: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      } else {
        // 'any'
        if (Array.isArray(targetCondition)) {
          // Multiple conditions: at least one sub-movement matches at least one condition
          const anyMatch = subMovements.some((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return targetCondition.includes(matchedRule?.condition ?? '');
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched (multi-condition)', { movement: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: at least one sub-movement matches the condition
          const anyMatch = subMovements.some((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || output.matchedRuleIndex == null || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex];
            return matchedRule?.condition === targetCondition;
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched', { movement: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      }
    }

    return -1;
  }
}
