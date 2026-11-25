import { z } from 'zod/v4';

export const PrCiFailureSchema = z.object({
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  complete: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    run: z.object({
      id: z.number().int().positive(), attempt: z.number().int().positive(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/i), url: z.string().url(),
    }),
    jobs: z.array(z.object({
      id: z.number().int().positive(), name: z.string(), url: z.string().url(), log: z.string().optional(),
      // Cancelled before any step ran: no log exists, and none is missing.
      notStarted: z.boolean().optional(),
      // Cancelled mid-execution after a sibling job in the same run failed (e.g. fail-fast): --log-failed has no log.
      cancelledBySibling: z.boolean().optional(),
    })),
  })),
  // Failed checks with no Actions log reference (commit statuses, third-party checks).
  // They stay failed; they are listed apart from evidence that should exist but could not be read.
  external: z.array(z.object({ name: z.string(), url: z.string().nullable().optional() })).optional(),
  unavailable: z.array(z.object({ name: z.string(), url: z.string().nullable().optional(), reason: z.string() })),
});

export const PrCiRerunSchema = z.object({
  number: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  runs: z.array(z.object({
    id: z.number().int().positive(), attempt: z.number().int().positive(), url: z.string().url().optional(),
  })).min(1),
});

export type PrCiFailure = z.infer<typeof PrCiFailureSchema>;
export type PrCiRerun = z.infer<typeof PrCiRerunSchema>;

export function ciFailureRunKey(run: PrCiFailure['checks'][number]['run']): string {
  const url = new URL(run.url);
  return JSON.stringify([url.origin, url.pathname.split('/').slice(0, 3), run.id, run.attempt]);
}

export function ciFailureRunsWithLogs(failure: Pick<PrCiFailure, 'checks'>): Set<string> {
  return new Set(
    failure.checks
      .filter(({ jobs }) => jobs.some((job) => job.log !== undefined && job.log.trim().length > 0))
      .map(({ run }) => ciFailureRunKey(run)),
  );
}

export interface PrCiCheck {
  kind: 'CheckRun' | 'StatusContext';
  name: string;
  url: string | null;
  finished: boolean;
  passed: boolean;
}

export interface PrCiRerunResult extends PrCiRerun {
  success: boolean;
  failed: boolean;
  headChanged?: boolean;
  error?: string;
}
