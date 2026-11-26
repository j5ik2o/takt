import { describe, expect, it } from 'vitest';
import { WorkflowStepRawSchema, type WorkflowStep } from '../core/models/index.js';
import { StepLoopGuard } from '../core/workflow/engine/step-visit-guard.js';
import { makeRule, makeStep } from './engine-test-helpers.js';

function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return makeStep('replan', {
    rules: [makeRule('continue', 'implement'), makeRule('review', 'peer-review')],
    ...overrides,
  });
}

/** Completes `count` visits with the given verdict and returns the last stop reason. */
function complete(guard: StepLoopGuard, target: WorkflowStep, verdicts: number[]): (string | undefined)[] {
  return verdicts.map(verdict => guard.recordCompletion(target, verdict));
}

describe('StepLoopGuard max_visits', () => {
  it('allows entries until max_visits visits have completed, then stops with one line', () => {
    const guard = new StepLoopGuard();
    const target = step({ maxVisits: 2 });

    expect(guard.checkEntry(target)).toBeUndefined();
    guard.recordCompletion(target, 0);
    expect(guard.checkEntry(target)).toBeUndefined();
    guard.recordCompletion(target, 0);

    const reason = guard.checkEntry(target);
    expect(reason).toBe('Visit limit reached: step "replan" already completed 2 times (max_visits: 2); stopping instead of another lap.');
    expect(reason).not.toContain('\n');
  });

  it('does not count retries of a visit that never completed', () => {
    const guard = new StepLoopGuard();
    const target = step({ maxVisits: 1 });

    for (let retry = 0; retry < 5; retry++) {
      expect(guard.checkEntry(target)).toBeUndefined();
    }
    guard.recordCompletion(target, 0);
    expect(guard.checkEntry(target)).toMatch(/already completed 1 times/);
  });

  it('counts each step separately and never stops a step without max_visits', () => {
    const guard = new StepLoopGuard();
    const limited = step({ maxVisits: 1 });
    const unlimited = makeStep('implement', { rules: [makeRule('done', 'replan')] });

    complete(guard, unlimited, [0, 0, 0, 0]);
    expect(guard.checkEntry(unlimited)).toBeUndefined();
    expect(guard.checkEntry(limited)).toBeUndefined();
  });
});

describe('StepLoopGuard stop_on_repeated_verdict', () => {
  it('stops when the same verdict comes twice in a row', () => {
    const guard = new StepLoopGuard();
    const target = step({ stopOnRepeatedVerdict: true });

    expect(complete(guard, target, [1, 1])).toEqual([
      undefined,
      'No progress: step "replan" returned the same verdict "review" twice in a row; stopping instead of another lap.',
    ]);
  });

  it('never stops while different verdicts alternate', () => {
    const guard = new StepLoopGuard();
    const target = step({ stopOnRepeatedVerdict: true });

    expect(complete(guard, target, [0, 1, 0, 1, 0, 1])).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('compares only with the previous visit', () => {
    const guard = new StepLoopGuard();
    const target = step({ stopOnRepeatedVerdict: true });

    expect(complete(guard, target, [0, 1, 0, 0])).toEqual([undefined, undefined, undefined, expect.stringMatching(/"continue" twice/)]);
  });

  it('ignores terminal transitions and steps without the setting', () => {
    const guard = new StepLoopGuard();
    const target = step({ stopOnRepeatedVerdict: true });
    const plain = step();

    expect(guard.recordCompletion(target, undefined)).toBeUndefined();
    expect(guard.recordCompletion(target, undefined)).toBeUndefined();
    expect(complete(guard, plain, [0, 0, 0])).toEqual([undefined, undefined, undefined]);
  });
});

describe('step schema lower bounds', () => {
  it.each([0, -1, 1.5])('rejects max_visits: %s', (maxVisits) => {
    expect(WorkflowStepRawSchema.safeParse({ name: 'replan', instruction: 'x', max_visits: maxVisits }).success).toBe(false);
  });

  it('accepts max_visits: 1', () => {
    expect(WorkflowStepRawSchema.safeParse({ name: 'replan', instruction: 'x', max_visits: 1 }).success).toBe(true);
  });
});
