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

/** mulberry32: a small seeded generator, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Settings {
  maxVisits: number | undefined;
  stopOnRepeatedVerdict: boolean;
  events: Event[];
}

function generate(seed: number): Settings {
  const next = random(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const event = (): Event => {
    switch (int(0, 3)) {
      case 0: return { kind: 'start' };
      case 1: return { kind: 'retry' };
      case 2: return { kind: 'complete', verdict: int(0, 2) };
      default: return { kind: 'finish' };
    }
  };
  return {
    maxVisits: next() < 0.2 ? undefined : int(1, 6),
    stopOnRepeatedVerdict: next() < 0.5,
    events: Array.from({ length: int(0, 60) }, event),
  };
}

/** Runs the property on PBT_NUM_RUNS generated cases; a failure names the seed and the case. */
function forAll(property: (settings: Settings) => void): void {
  for (let seed = 1; seed <= PBT_NUM_RUNS; seed++) {
    const settings = generate(seed);
    try {
      property(settings);
    } catch (error) {
      throw new Error(`property failed for seed ${seed}: ${JSON.stringify(settings)}\n${String(error)}`);
    }
  }
}

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

describe('StepLoopGuard properties', () => {
  it('never starts more than max_visits visits, and stops at the limit only after max_visits completed', () => {
    forAll(({ maxVisits, stopOnRepeatedVerdict, events }) => {
      const outcome = replay(maxVisits, stopOnRepeatedVerdict, events);
      if (maxVisits !== undefined) expect(outcome.startedVisits).toBeLessThanOrEqual(maxVisits);
      if (outcome.stop?.at === 'limit') {
        expect(maxVisits).toBeDefined();
        expect(outcome.completedVisits).toBe(maxVisits);
      }
    });
  });

  it('stops on repetition exactly when two equal verdicts come in a row', () => {
    forAll(({ maxVisits, stopOnRepeatedVerdict, events }) => {
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
    });
  });

  it('leaves one line that names the step whenever it stops', () => {
    forAll(({ maxVisits, stopOnRepeatedVerdict, events }) => {
      const outcome = replay(maxVisits, stopOnRepeatedVerdict, events);
      if (outcome.stop === undefined) return;
      expect(outcome.stop.reason).not.toMatch(/[\r\n]/);
      expect(outcome.stop.reason).toContain('step "replan"');
    });
  });
});
