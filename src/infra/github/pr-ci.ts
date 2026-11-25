import { z } from 'zod/v4';
import type { PrStatus, PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import { PrCiFailureSchema, PrCiRerunSchema,
  type PrCiFailure, type PrCiRerun, type PrCiRerunResult } from '../../core/workflow/system/pr-ci.js';
import { runPrCommand } from './pr-command.js';
import { assertGitHubPullRequestTarget, type GitHubPullRequestTarget } from './pull-request-target.js';

const FAILED_LOG_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_FAILED_LOG_CHARS = 200_000;

const RunJobStepSchema = z.object({
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  number: z.number().int().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});

const RunSchema = z.object({
  databaseId: z.number().int().positive(),
  url: z.string().url(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  jobs: z.array(z.object({
    databaseId: z.number().int().positive(), name: z.string(), url: z.string().url(),
    status: z.string(), conclusion: z.string().nullable(),
    startedAt: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    steps: z.array(RunJobStepSchema).optional(),
  })),
});
type CiRun = z.infer<typeof RunSchema>;
type CiRunJob = CiRun['jobs'][number];

const CheckRunAnnotationsSchema = z.array(z.object({
  path: z.string().optional(),
  annotation_level: z.string().optional(),
  message: z.string(),
}));
type CheckRunAnnotation = z.infer<typeof CheckRunAnnotationsSchema>[number];

const NON_FAILING_CANCELLED_STEP_CONCLUSIONS = new Set(['success', 'cancelled', 'skipped', 'neutral']);
const FAIL_FAST_ANNOTATION_PATTERN = /^The strategy configuration was canceled because "[^"]+" failed\.?$/;

function hasFailFastCancellationAnnotation(annotations: readonly CheckRunAnnotation[]): boolean {
  return annotations.some((annotation) =>
    annotation.path === '.github'
    && annotation.annotation_level === 'failure'
    && FAIL_FAST_ANNOTATION_PATTERN.test(annotation.message.trim()),
  );
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Returns sibling job IDs in the same failed run whose `failure` completion fell within
 * this cancelled job's execution window (fail-fast cancellation candidate).
 * Returns empty when chronology or step state cannot be established from the run JSON.
 */
function siblingFailuresDuringCancelledJob(run: CiRun, job: CiRunJob): number[] {
  if (run.conclusion !== 'failure') return [];
  if (job.status !== 'completed' || job.conclusion !== 'cancelled') return [];
  if (!job.steps || job.steps.length === 0) return [];
  if (!job.steps.every((step) => step.conclusion != null && NON_FAILING_CANCELLED_STEP_CONCLUSIONS.has(step.conclusion))) {
    return [];
  }
  const jobStartedAt = parseTimestamp(job.startedAt);
  const jobCompletedAt = parseTimestamp(job.completedAt);
  if (jobStartedAt === undefined || jobCompletedAt === undefined || jobCompletedAt < jobStartedAt) return [];
  return run.jobs
    .filter((sibling) => {
      if (sibling.databaseId === job.databaseId) return false;
      if (sibling.status !== 'completed' || sibling.conclusion !== 'failure') return false;
      const siblingCompletedAt = parseTimestamp(sibling.completedAt);
      return siblingCompletedAt !== undefined && jobStartedAt <= siblingCompletedAt && siblingCompletedAt <= jobCompletedAt;
    })
    .map((sibling) => sibling.databaseId);
}

const PrHeadSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
});

export function actionsReference(value: string) {
  const url = new URL(value);
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?(?:\/(jobs?)\/(\d+))?\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !match) throw new Error('Unsupported Actions check URL');
  return { id: Number(match[3]), repository: `${url.hostname}/${match[1]}/${match[2]}`,
    hostname: url.hostname, owner: match[1]!, repo: match[2]!,
    // Only `/job/<id>` carries the job's database ID; the number in `/jobs/<number>` is a different identifier.
    jobId: match[4] === 'job' ? Number(match[5]) : undefined };
}

async function readJobAnnotations(
  hostname: string,
  owner: string,
  repo: string,
  jobId: number,
  cwd: string,
  options?: PrStatusFetchOptions,
): Promise<CheckRunAnnotation[]> {
  return CheckRunAnnotationsSchema.parse(JSON.parse(await runPrCommand([
    'api',
    `repos/${owner}/${repo}/check-runs/${jobId}/annotations?per_page=100`,
    '--hostname', hostname,
  ], cwd, options)));
}

async function readRun(id: number, cwd: string, options?: PrStatusFetchOptions, url?: string, target?: GitHubPullRequestTarget): Promise<CiRun> {
  const run = RunSchema.parse(JSON.parse(await runPrCommand([
    'run', 'view', String(id), '--json', 'databaseId,url,headSha,attempt,status,conclusion,jobs',
    ...(target === undefined ? [] : ['--repo', `${target.hostname}/${target.owner}/${target.repo}`]),
  ], cwd, options)));
  if (run.databaseId !== id || actionsReference(run.url).id !== id) throw new Error('Actions run ID does not match the requested run');
  if (url !== undefined && actionsReference(run.url).repository !== actionsReference(url).repository) {
    throw new Error('Actions run repository does not match the failed check');
  }
  return run;
}

/** `undefined`: the check has no Actions log. `'unreadable'`: it points at Actions, but not in a form we can read. */
function actionsCheckReference(check: { kind: string; url: string | null }) {
  if (check.kind !== 'CheckRun' || check.url === null) return undefined;
  try { return { ...actionsReference(check.url), url: check.url }; }
  catch {
    try { return new URL(check.url).pathname.includes('/actions/runs/') ? 'unreadable' as const : undefined; }
    catch { return undefined; }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectPrCiFailure(
  status: PrStatus, headSha: string, cwd: string, options?: PrStatusFetchOptions,
  target?: GitHubPullRequestTarget,
): Promise<PrCiFailure> {
  const result: PrCiFailure = { number: status.number, headSha, complete: false, checks: [], unavailable: [] };
  if (status.headSha !== headSha || !status.ci.finished || status.ci.passed) {
    result.unavailable.push({ name: 'CI', reason: 'PR HEAD or completed failure does not match the investigation target' });
    return result;
  }
  const runs = new Map<string, Promise<CiRun>>();
  const logs = new Map<string, Promise<string | null>>();
  const annotations = new Map<string, Promise<CheckRunAnnotation[]>>();
  const loggedJobsByRun = new Map<string, Set<number>>();
  const pendingSiblingCancellations: Array<{
    check: PrCiFailure['checks'][number];
    jobIndex: number;
    runKey: string;
    siblingIds: number[];
  }> = [];
  const external: NonNullable<PrCiFailure['external']> = [];
  for (const check of status.ci.checks ?? []) {
    if (!check.finished || check.passed) continue;
    const reference = actionsCheckReference(check);
    if (reference === undefined) {
      external.push({ name: check.name, url: check.url });
      continue;
    }
    if (reference === 'unreadable') {
      result.unavailable.push({ name: check.name, url: check.url, reason: 'Unsupported Actions check URL' });
      continue;
    }
    try {
      const key = `${reference.repository}/${reference.id}`;
      let pending = runs.get(key);
      if (!pending) {
        pending = readRun(reference.id, cwd, options, reference.url, target);
        runs.set(key, pending);
      }
      const run = await pending;
      if (run.headSha !== headSha) throw new Error('Actions run HEAD does not match the failed PR HEAD');
      if (run.status !== 'completed') throw new Error('Actions run has not completed');
      const runFailedJobs = run.jobs.filter((job) => job.status === 'completed'
        && !['success', 'neutral', 'skipped'].includes(job.conclusion ?? ''));
      // A check that names its failed job owns only that job's evidence; a sibling job's state is not its concern.
      // When the named job is not a failed job of this attempt (the run was rerun, or the check was marked failed
      // from the run's result), the run's failed jobs stand in, as they do for a check that names no job.
      const ownFailedJobs = runFailedJobs.filter((job) => job.databaseId === reference.jobId);
      const failedJobs = ownFailedJobs.length > 0 ? ownFailedJobs : runFailedJobs;
      if (failedJobs.length === 0) throw new Error('No failed job evidence is available');
      const jobs: PrCiFailure['checks'][number]['jobs'] = [];
      const checkLoggedJobIds: number[] = [];
      const checkSiblingCancellations: Array<{ jobIndex: number; siblingIds: number[] }> = [];
      for (const job of failedJobs) {
        const jobReference = actionsReference(job.url);
        if (jobReference.id !== run.databaseId || jobReference.repository !== reference.repository) {
          throw new Error('Failed job reference does not match the Actions run');
        }
        const details = { id: job.databaseId, name: job.name, url: job.url };
        if (job.conclusion === 'cancelled' && job.steps?.length === 0) {
          jobs.push({ ...details, notStarted: true });
          continue;
        }
        try {
          const logKey = `${key}/${run.attempt}/${job.databaseId}`;
          let pendingLog = logs.get(logKey);
          if (!pendingLog) {
            pendingLog = runPrCommand([
              'run', 'view', String(run.databaseId),
              '--attempt', String(run.attempt), '--job', String(job.databaseId), '--log-failed',
              ...(target === undefined ? [] : ['--repo', `${target.hostname}/${target.owner}/${target.repo}`]),
            ], cwd, options, FAILED_LOG_MAX_BUFFER).then((text) => {
              if (text.trim().length === 0) return null;
              return text.length > MAX_FAILED_LOG_CHARS
                ? `[truncated: last ${MAX_FAILED_LOG_CHARS} characters]\n${text.slice(-MAX_FAILED_LOG_CHARS)}`
                : text;
            });
            logs.set(logKey, pendingLog);
          }
          const log = await pendingLog;
          if (log === null) {
            const siblingIds = siblingFailuresDuringCancelledJob(run, job);
            if (siblingIds.length === 0) throw new Error(`Failed job ${job.databaseId} has no log content`);
            let pendingAnnotations = annotations.get(logKey);
            if (!pendingAnnotations) {
              pendingAnnotations = readJobAnnotations(
                target?.hostname ?? reference.hostname,
                target?.owner ?? reference.owner,
                target?.repo ?? reference.repo,
                job.databaseId,
                cwd,
                options,
              );
              annotations.set(logKey, pendingAnnotations);
            }
            const jobAnnotations = await pendingAnnotations;
            if (!hasFailFastCancellationAnnotation(jobAnnotations)) {
              throw new Error(`Failed job ${job.databaseId} has no log content`);
            }
            checkSiblingCancellations.push({ jobIndex: jobs.length, siblingIds });
            jobs.push({ ...details, cancelledBySibling: true });
          } else {
            jobs.push({ ...details, log });
            checkLoggedJobIds.push(job.databaseId);
          }
        } catch (error) {
          options?.signal?.throwIfAborted();
          jobs.push(details);
          result.unavailable.push({ name: check.name, url: job.url, reason: errorText(error) });
        }
      }
      const checkEntry = {
        name: check.name,
        run: { id: run.databaseId, attempt: run.attempt, headSha: run.headSha, url: run.url },
        jobs,
      };
      result.checks.push(checkEntry);
      if (checkLoggedJobIds.length > 0) {
        let logged = loggedJobsByRun.get(key);
        if (!logged) {
          logged = new Set<number>();
          loggedJobsByRun.set(key, logged);
        }
        for (const id of checkLoggedJobIds) logged.add(id);
      }
      for (const pendingCancellation of checkSiblingCancellations) {
        pendingSiblingCancellations.push({
          check: checkEntry,
          jobIndex: pendingCancellation.jobIndex,
          runKey: key,
          siblingIds: pendingCancellation.siblingIds,
        });
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      result.unavailable.push({ name: check.name, url: check.url, reason: errorText(error) });
    }
  }
  for (const entry of pendingSiblingCancellations) {
    const logged = loggedJobsByRun.get(entry.runKey);
    if (entry.siblingIds.some((id) => logged?.has(id))) continue;
    const job = entry.check.jobs[entry.jobIndex]!;
    entry.check.jobs[entry.jobIndex] = { id: job.id, name: job.name, url: job.url };
    result.unavailable.push({
      name: entry.check.name,
      url: job.url,
      reason: `Failed job ${job.id} has no log content`,
    });
  }
  if (external.length > 0) result.external = external;
  if (result.checks.length === 0 && result.unavailable.length === 0) {
    result.unavailable.push({ name: 'CI', reason: external.length > 0
      ? 'Only checks without Actions logs failed; there is no Actions evidence to diagnose'
      : 'Failed check details are unavailable' });
  }
  result.complete = result.checks.length > 0 && result.unavailable.length === 0;
  return result;
}

export async function rerunPrCi(failure: PrCiFailure, cwd: string, options?: PrStatusFetchOptions, pullRequest?: GitHubPullRequestTarget): Promise<PrCiRerunResult> {
  const evidence = PrCiFailureSchema.parse(failure);
  const runs = [...new Map(evidence.checks.map(({ run }) => [run.url, {
    id: run.id, attempt: run.attempt, url: run.url,
  }])).values()];
  const result: PrCiRerunResult = { number: evidence.number, headSha: evidence.headSha, runs,
    success: false, failed: true };
  try {
    if (!evidence.complete || evidence.unavailable.length > 0 || runs.length === 0) {
      throw new Error('Complete failure evidence is required to rerun CI');
    }
    // Validate every target before starting any side effect.
    for (const target of runs) {
      const current = await readRun(target.id, cwd, options, target.url, pullRequest);
      if (current.headSha !== evidence.headSha || current.attempt !== target.attempt
        || current.status !== 'completed' || ['success', 'neutral', 'skipped'].includes(current.conclusion ?? '')) {
        throw new Error('Actions run changed since investigation');
      }
    }
    for (const target of runs) {
      const output = await runPrCommand([
        'pr', 'view', pullRequest?.url ?? String(evidence.number), '--json',
        pullRequest === undefined ? 'number,headRefOid' : 'number,headRefOid,url',
      ], cwd, options);
      if (pullRequest !== undefined) assertGitHubPullRequestTarget(JSON.parse(output).url, pullRequest);
      const current = PrHeadSchema.parse(JSON.parse(output));
      if (current.number !== evidence.number) throw new Error('PR status response does not match the requested PR');
      if (current.headRefOid !== evidence.headSha) {
        return { ...result, headChanged: true,
          error: `PR HEAD changed from ${evidence.headSha} to ${current.headRefOid} before CI rerun` };
      }
      await runPrCommand(['run', 'rerun', String(target.id), '--failed',
        ...(pullRequest === undefined ? [] : ['--repo', `${pullRequest.hostname}/${pullRequest.owner}/${pullRequest.repo}`])], cwd, options);
    }
    return { ...result, success: true, failed: false };
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { ...result, error: errorText(error) };
  }
}

export async function readCiRerunStatus(
  status: PrStatus, value: PrCiRerun, cwd: string, options?: PrStatusFetchOptions,
  supersededRuns: ReadonlyMap<number, string> = new Map(),
  pullRequest?: GitHubPullRequestTarget,
): Promise<PrStatus['ci']> {
  const rerun = PrCiRerunSchema.parse(value);
  if (rerun.number !== status.number) throw new Error('CI rerun target no longer matches the PR');
  if (rerun.headSha !== status.headSha) {
    return { finished: false, passed: false, checks: status.ci.checks,
      rerunHeadChange: { reason: `PR HEAD changed from ${rerun.headSha} to ${status.headSha} after CI rerun` } };
  }
  let checks = status.ci.checks ?? [];
  let finished = true;
  let passed = true;
  let pendingTargets = 0;
  for (const target of rerun.runs) {
    if (target.url) {
      let reference: ReturnType<typeof actionsReference> | undefined;
      try { reference = actionsReference(target.url); }
      catch { /* Invalid references remain subject to the normal rerun validation. */ }
      if (reference?.id === target.id && supersededRuns.get(target.id) === reference.repository) continue;
    }
    pendingTargets++;
    const run = await readRun(target.id, cwd, options, target.url, pullRequest);
    if (run.headSha !== status.headSha) throw new Error('CI rerun HEAD does not match the PR');
    const completed = run.attempt > target.attempt && run.status === 'completed';
    const succeeded = completed && ['success', 'neutral', 'skipped'].includes(run.conclusion ?? '');
    checks = checks.map((check) => {
      if (check.kind !== 'CheckRun' || check.url === null) return check;
      let reference: ReturnType<typeof actionsReference>;
      try { reference = actionsReference(check.url); }
      catch { return check; }
      if (reference.id !== run.databaseId || reference.repository !== actionsReference(run.url).repository) return check;
      return { ...check, finished: completed, passed: succeeded };
    });
    finished = finished && completed;
    passed = passed && succeeded;
  }
  if (pendingTargets === 0) return status.ci;
  finished = finished && checks.length > 0 && checks.every((check) => check.finished);
  return { finished, passed: finished && passed && checks.every((check) => check.passed), checks };
}
