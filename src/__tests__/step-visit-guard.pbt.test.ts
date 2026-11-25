import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StepLoopGuard } from '../core/workflow/engine/step-visit-guard.js';
import { makeRule, makeStep } from './engine-test-helpers.js';

const PBT_NUM_RUNS = (() => {
  const parsed = Number.parseInt(process.env.TAKT_PBT_NUM_RUNS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return process.env.CI ? 100 : 1000;
})();

/**
 * One run-loop event for the guarded step, as WorkflowRunLoop produces them:
 * `start` and `retry` call checkEntry (a retry re-enters the visit that has not completed),
 * `complete` records a non-terminal verdict, `finish` records a terminal transition.
 */
type Event =
  | { kind: 'start' }
  | { kind: 'retry' }
  | { kind: 'complete'; verdict: number }
  | { kind: 'finish' };

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  fc.constant<Event>({ kind: 'start' }),
  fc.constant<Event>({ kind: 'retry' }),
  fc.integer({ min: 0, max: 2 }).map((verdict): Event => ({ kind: 'complete', verdict })),
  fc.constant<Event>({ kind: 'finish' }),
);

interface Outcome {
  stop?: { reason: string; at: 'limit' | 'repeat' };
  startedVisits: number;
  completedVisits: number;
  verdicts: number[];
}

/** Replays the events the way the run loop would, skipping events that cannot happen in the current phase. */
function replay(maxVisits: number | undefined, stopOnRepeatedVerdict: boolean, events: Event[]): Outcome {
  const guard = new StepLoopGuard();
  const step = makeStep('replan', {
    rules: [makeRule('a', 'implement'), makeRule('b', 'implement'), makeRule('c', 'implement')],
    ...(maxVisits === undefined ? {} : { maxVisits }),
    ...(stopOnRepeatedVerdict ? { stopOnRepeatedVerdict: true } : {}),
  });
  const outcome: Outcome = { startedVisits: 0, completedVisits: 0, verdicts: [] };
  let inVisit = false;
  for (const event of events) {
    if (event.kind === 'start' || event.kind === 'retry') {
      if ((event.kind === 'start') === inVisit) continue;
      const reason = guard.checkEntry(step);
      if (reason !== undefined) return { ...outcome, stop: { reason, at: 'limit' } };
      if (event.kind === 'start') outcome.startedVisits++;
      inVisit = true;
      continue;
    }
    if (!inVisit) continue;
    inVisit = false;
    outcome.completedVisits++;
    if (event.kind === 'finish') {
      guard.recordCompletion(step, undefined);
      return outcome;
    }
    outcome.verdicts.push(event.verdict);
    const reason = guard.recordCompletion(step, event.verdict);
    if (reason !== undefined) return { ...outcome, stop: { reason, at: 'repeat' } };
  }
  return outcome;
}

const settingsArb = fc.record({
  maxVisits: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  stopOnRepeatedVerdict: fc.boolean(),
  events: fc.array(eventArb, { maxLength: 60 }),
});

describe('StepLoopGuard properties', () => {
  it('never starts more than max_visits visits, and stops at the limit only after max_visits completed', () => {
    fc.assert(fc.property(settingsArb, ({ maxVisits, stopOnRepeatedVerdict, events }) => {
      const outcome = replay(maxVisits, stopOnRepeatedVerdict, events);
      if (maxVisits !== undefined) expect(outcome.startedVisits).toBeLessThanOrEqual(maxVisits);
      if (outcome.stop?.at === 'limit') {
        expect(maxVisits).toBeDefined();
        expect(outcome.completedVisits).toBe(maxVisits);
      }
    }), { numRuns: PBT_NUM_RUNS });
  });

  it('stops on repetition exactly when two equal verdicts come in a row', () => {
    fc.assert(fc.property(settingsArb, ({ maxVisits, stopOnRepeatedVerdict, events }) => {
      const outcome = replay(maxVisits, stopOnRepeatedVerdict, events);
      const { verdicts } = outcome;
      const pairs = verdicts.slice(1).map((verdict, index) => verdict === verdicts[index]);
      if (outcome.stop?.at === 'repeat') {
        expect(stopOnRepeatedVerdict).toBe(true);
        expect(pairs.at(-1)).toBe(true);
        expect(pairs.slice(0, -1)).not.toContain(true);
      } else if (stopOnRepeatedVerdict) {
        expect(pairs).not.toContain(true);
      }
    }), { numRuns: PBT_NUM_RUNS });
  });

  it('leaves one line that names the step whenever it stops', () => {
    fc.assert(fc.property(settingsArb, ({ maxVisits, stopOnRepeatedVerdict, events }) => {
      const outcome = replay(maxVisits, stopOnRepeatedVerdict, events);
      if (outcome.stop === undefined) return;
      expect(outcome.stop.reason).not.toMatch(/[\r\n]/);
      expect(outcome.stop.reason).toContain('step "replan"');
    }), { numRuns: PBT_NUM_RUNS });
  });
});
