import type { WorkflowStep } from '../models/types.js';
import { ABORT_STEP } from './constants.js';

function exitsOf(step: WorkflowStep): (string | undefined)[] | undefined {
  if (step.rules === undefined || step.rules.length === 0) return undefined;
  const exits = step.rules.map((rule) => (rule.requiresUserInput === true ? undefined : rule.next));
  if (step.kind === 'system' && step.wait !== undefined) exits.push(step.wait.onTimeout);
  return exits;
}

/**
 * True when every exit of the step ends the workflow in ABORT, directly or
 * through steps that themselves can only abort. A step whose outcome is not
 * fully described by `next` targets is never reported.
 */
export function stepOnlyAborts(
  steps: readonly WorkflowStep[],
  stepName: string,
  visiting: ReadonlySet<string> = new Set(),
): boolean {
  if (visiting.has(stepName)) return false;
  const matches = steps.filter((candidate) => candidate.name === stepName);
  if (matches.length !== 1) return false;
  const exits = exitsOf(matches[0]!);
  if (exits === undefined) return false;
  const path = new Set(visiting).add(stepName);
  return exits.every((next) => next === ABORT_STEP
    || (next !== undefined && stepOnlyAborts(steps, next, path)));
}

/** Names of the steps that route directly into `stepName`. */
export function stepsRoutingTo(steps: readonly WorkflowStep[], stepName: string): string[] {
  return steps
    .filter((step) => step.name !== stepName && (exitsOf(step) ?? []).includes(stepName))
    .map((step) => step.name);
}
