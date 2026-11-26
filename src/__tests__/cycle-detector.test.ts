import { describe, expect, it } from 'vitest';
import type { LoopMonitorConfig } from '../core/models/index.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { CycleDetector } from '../core/workflow/engine/cycle-detector.js';
import { LoopMonitorSchema } from '../core/models/workflow-schemas.js';

function makeMonitor(
  cycle: string[],
  threshold: number,
  ignoreSteps?: string[],
  minTriggerVisits?: number,
): LoopMonitorConfig {
  return {
    cycle,
    ignoreSteps,
    threshold,
    ...(minTriggerVisits === undefined ? {} : { minTriggerVisits }),
    judge: {
      rules: [
        { condition: parseWorkflowRuleCondition('progress'), next: cycle[0]! },
        { condition: parseWorkflowRuleCondition('stalled'), next: 'ABORT' },
      ],
    },
  };
}

function recordCycle(detector: CycleDetector, cycle: readonly string[], nextStep: string): ReturnType<CycleDetector['recordAndCheck']> {
  let result: ReturnType<CycleDetector['recordAndCheck']> = { triggered: false, cycleCount: 0 };
  for (const step of cycle) {
    result = detector.recordAndCheck(step, step === cycle.at(-1) ? nextStep : '__within_cycle__');
  }
  return result;
}

describe('CycleDetector', () => {
  it.each([
    { cycle: [], valid: false },
    { cycle: ['fix'], valid: true },
    { cycle: ['review', 'fix'], valid: true },
  ])('validates a nonempty monitor cycle $cycle', ({ cycle, valid }) => {
    expect(LoopMonitorSchema.safeParse({
      cycle, threshold: 4,
      judge: { rules: [{ condition: 'healthy', next: 'fix' }] },
    }).success).toBe(valid);
  });

  it('rejects ignoring the sole monitored step', () => {
    expect(LoopMonitorSchema.safeParse({
      cycle: ['fix'], ignore_steps: ['fix'], threshold: 4,
      judge: { rules: [{ condition: 'healthy', next: 'fix' }] },
    }).success).toBe(false);
  });

  it('triggers at the threshold only when the natural transition re-enters the cycle', () => {
    const monitor = makeMonitor(['reviewers', 'fix'], 3);
    const detector = new CycleDetector([monitor]);

    expect(recordCycle(detector, monitor.cycle, 'reviewers').triggered).toBe(false);
    expect(recordCycle(detector, monitor.cycle, 'reviewers').triggered).toBe(false);
    const result = recordCycle(detector, monitor.cycle, 'reviewers');

    expect(result).toEqual({ triggered: true, cycleCount: 3, monitor });
  });

  it('does not trigger when a completed cycle naturally exits to another step', () => {
    const monitor = makeMonitor(['fix', 'reviewers'], 2);
    const detector = new CycleDetector([monitor]);

    recordCycle(detector, monitor.cycle, 'fix');
    const result = recordCycle(detector, monitor.cycle, 'final-gate');

    expect(result.triggered).toBe(false);
    expect(detector.getHistory()).toEqual(['fix', 'reviewers', 'fix', 'reviewers']);
  });

  it('uses the proposed next step to select the monitor that would actually repeat', () => {
    const shortMonitor = makeMonitor(['fix', 'reviewers'], 2);
    const finalGateMonitor = makeMonitor(['fix', 'reviewers', 'final-gate'], 2);
    const detector = new CycleDetector([shortMonitor, finalGateMonitor]);

    recordCycle(detector, finalGateMonitor.cycle, 'fix');
    const result = recordCycle(detector, finalGateMonitor.cycle, 'fix');

    expect(result.triggered).toBe(true);
    expect(result.monitor).toBe(finalGateMonitor);
  });

  it('resets completed history after judge intervention', () => {
    const monitor = makeMonitor(['A', 'B'], 1);
    const detector = new CycleDetector([monitor]);

    expect(recordCycle(detector, monitor.cycle, 'A').triggered).toBe(true);
    detector.reset();

    expect(detector.getHistory()).toEqual([]);
    expect(detector.recordAndCheck('A', 'B').triggered).toBe(false);
  });

  it('counts a logical cycle while ignoring configured intermediate steps', () => {
    const monitor = makeMonitor(['review', 'fix'], 2, ['verify', 'retry']);
    const detector = new CycleDetector([monitor]);

    detector.recordAndCheck('review', 'fix');
    detector.recordAndCheck('fix', 'verify');
    detector.recordAndCheck('verify', 'retry');
    detector.recordAndCheck('retry', 'verify');
    expect(detector.recordAndCheck('verify', 'review').triggered).toBe(false);

    detector.recordAndCheck('review', 'fix');
    detector.recordAndCheck('fix', 'verify');
    detector.recordAndCheck('verify', 'retry');
    detector.recordAndCheck('retry', 'verify');
    detector.recordAndCheck('verify', 'retry');
    detector.recordAndCheck('retry', 'verify');
    const result = detector.recordAndCheck('verify', 'review');

    expect(result).toEqual({ triggered: true, cycleCount: 2, monitor });
    expect(detector.getHistory()).toHaveLength(12);
  });

  it('never triggers without configured monitors', () => {
    const detector = new CycleDetector();

    expect(detector.recordAndCheck('A', 'A').triggered).toBe(false);
  });

  describe('min_trigger_visits', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2', null])(
      'rejects invalid min_trigger_visits: %s',
      (minTriggerVisits) => {
        expect(LoopMonitorSchema.safeParse({
          cycle: ['replan', 'peer-review'],
          threshold: 1,
          min_trigger_visits: minTriggerVisits,
          judge: { rules: [{ condition: 'healthy', next: 'replan' }] },
        }).success).toBe(false);
      },
    );

    it.each([1, 2, Number.MAX_SAFE_INTEGER])('accepts valid min_trigger_visits: %s', (minTriggerVisits) => {
      const parsed = LoopMonitorSchema.safeParse({
        cycle: ['replan', 'peer-review'],
        threshold: 1,
        min_trigger_visits: minTriggerVisits,
        judge: { rules: [{ condition: 'healthy', next: 'replan' }] },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.min_trigger_visits).toBe(minTriggerVisits);
      }
    });

    it('delays triggering until the last step of cycle has completed minTriggerVisits times, and preserves counts across reset()', () => {
      const monitor = makeMonitor(['replan', 'peer-review'], 1, ['implement'], 2);
      const detector = new CycleDetector([monitor]);

      // First lap: replan -> implement -> peer-review -> replan (peer-review completed 1 < 2)
      expect(detector.recordAndCheck('replan', 'implement').triggered).toBe(false);
      expect(detector.recordAndCheck('implement', 'peer-review').triggered).toBe(false);
      expect(detector.recordAndCheck('peer-review', 'replan').triggered).toBe(false);

      // Second lap: replan -> implement -> peer-review -> replan (peer-review completed 2 >= 2, 2 cycles in history)
      expect(detector.recordAndCheck('replan', 'implement').triggered).toBe(false);
      expect(detector.recordAndCheck('implement', 'peer-review').triggered).toBe(false);
      expect(detector.recordAndCheck('peer-review', 'replan')).toEqual({
        triggered: true,
        cycleCount: 2,
        monitor,
      });

      // reset() clears history but keeps completedCounts so the 3rd lap also triggers
      detector.reset();
      expect(detector.getHistory()).toEqual([]);
      expect(detector.recordAndCheck('replan', 'implement').triggered).toBe(false);
      expect(detector.recordAndCheck('implement', 'peer-review').triggered).toBe(false);
      expect(detector.recordAndCheck('peer-review', 'replan')).toEqual({
        triggered: true,
        cycleCount: 1,
        monitor,
      });
    });

    it('triggers on the first completion when minTriggerVisits is 1', () => {
      const monitor = makeMonitor(['A', 'B'], 1, undefined, 1);
      const detector = new CycleDetector([monitor]);

      expect(recordCycle(detector, monitor.cycle, 'A')).toEqual({
        triggered: true,
        cycleCount: 1,
        monitor,
      });
    });

    it('checks completed count of cycle lastStep rather than stepName when ignoreSteps sit after lastStep', () => {
      const monitor = makeMonitor(['review', 'fix'], 1, ['verify'], 2);
      const detector = new CycleDetector([monitor]);

      // review -> fix (count 1) -> verify (count 1) -> verify (count 2) -> review
      expect(detector.recordAndCheck('review', 'fix').triggered).toBe(false);
      expect(detector.recordAndCheck('fix', 'verify').triggered).toBe(false);
      expect(detector.recordAndCheck('verify', 'verify').triggered).toBe(false);
      // Even though verify completed 2 times, lastStep ("fix") completed only 1 time (< 2).
      expect(detector.recordAndCheck('verify', 'review').triggered).toBe(false);

      // Second lap: fix completes a 2nd time -> triggers on verify -> review (2 cycles in history)
      expect(detector.recordAndCheck('review', 'fix').triggered).toBe(false);
      expect(detector.recordAndCheck('fix', 'verify').triggered).toBe(false);
      expect(detector.recordAndCheck('verify', 'review')).toEqual({
        triggered: true,
        cycleCount: 2,
        monitor,
      });
    });

    it('matches the unguarded monitor iff lastStep completions reached minTriggerVisits, across arbitrary sequences and resets', () => {
      const steps = ['replan', 'implement', 'peer-review', 'verify'] as const;
      const mulberry32 = (seed: number): (() => number) => {
        let state = seed >>> 0;
        return () => {
          state = (state + 0x6d2b79f5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      };

      for (let seed = 1; seed <= 200; seed++) {
        const next = mulberry32(seed);
        const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
        const minTriggerVisits = int(1, 4);
        const threshold = int(1, 2);
        const guardedMonitor = makeMonitor(['replan', 'peer-review'], threshold, ['implement'], minTriggerVisits);
        const plainMonitor = makeMonitor(['replan', 'peer-review'], threshold, ['implement']);
        const guarded = new CycleDetector([guardedMonitor]);
        const plain = new CycleDetector([plainMonitor]);
        let peerReviewCompletions = 0;

        const ops = int(1, 40);
        for (let i = 0; i < ops; i++) {
          if (next() < 0.15) {
            guarded.reset();
            plain.reset();
            // reset() must not reduce completedCounts
            continue;
          }
          const completed = steps[int(0, steps.length - 1)]!;
          const nextStep = steps[int(0, steps.length - 1)]!;
          if (completed === 'peer-review') {
            peerReviewCompletions++;
          }
          const guardedResult = guarded.recordAndCheck(completed, nextStep);
          const plainResult = plain.recordAndCheck(completed, nextStep);

          if (peerReviewCompletions < minTriggerVisits) {
            // Forward property: never triggers below minTriggerVisits
            expect(guardedResult.triggered).toBe(false);
          } else {
            // Reverse property: once >= minTriggerVisits, triggers whenever the unguarded monitor triggers
            expect(guardedResult.triggered).toBe(plainResult.triggered);
            expect(guardedResult.cycleCount).toBe(plainResult.cycleCount);
          }
        }
      }
    });
  });
});
