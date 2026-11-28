/**
 * A retry of a goal task that failed on the builtin worker resumes a run saved on the daemon
 * machine, so only the builtin worker may run it (#209). The pool schedule and the remote claim
 * both keep it off remote workers, and a builtin concurrency of 0 is shown as a waiting reason with
 * one warning instead of a silent stop.
 * Design: docs/design/worker-pool-local-resume-routing.md, docs/design/193-worker-pool-requests.md (S9-S13).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as scheduler from '../core/worker-pool/scheduler.js';
import { scheduleWorkerPool, workerPoolAvailability } from '../core/worker-pool/scheduler.js';
import type { PoolProject, PoolTask, PoolWorker } from '../core/worker-pool/types.js';
import { RemoteAssignmentSchema } from '../core/worker-pool/remoteProtocol.js';
import type { WorkflowResumePoint } from '../core/models/index.js';
import { BuiltinProjectRuntime } from '../features/workerPool/builtinProjectRuntime.js';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { TasksFileSchema, type TaskRecord, type TasksFileData } from '../infra/task/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), sha: vi.fn(), text: vi.fn(), goal: vi.fn(), updateGoal: vi.fn(),
  config: vi.fn(), owner: vi.fn(), acquire: vi.fn(), terminate: vi.fn(), cleanup: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git, resolveGoalBranchSha: doubles.sha, goalGitText: doubles.text }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; update = doubles.updateGoal; } }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: vi.fn() }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/config/index.js', async (original) => ({
  ...await original<typeof import('../infra/config/index.js')>(),
  invalidateGlobalConfigCache: vi.fn(), resolveWorkflowConfigValues: () => ({ concurrency: 3, ignoreExceed: false }),
}));
vi.mock('../infra/task/project-execution-lock.js', () => ({ acquireProjectExecutionLock: doubles.acquire,
  getProjectExecutionOwner: doubles.owner, ProjectExecutionAlreadyRunningError: class extends Error {},
}));
vi.mock('../features/tasks/execute/claimTasks.js', async (original) => ({
  ...await original<typeof import('../features/tasks/execute/claimTasks.js')>(), failInterruptedTasksWithGoalEvents: vi.fn(),
}));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkQueuedTaskProviders: vi.fn() }));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndCompleteWithDetails: vi.fn() }));
vi.mock('../shared/utils/spawn.js', async (original) => ({
  ...await original<typeof import('../shared/utils/spawn.js')>(), terminateManagedProcesses: doubles.terminate,
}));
vi.mock('../infra/opencode/server-pool.js', async (original) => ({
  ...await original<typeof import('../infra/opencode/server-pool.js')>(), prepareSharedServerPoolForForcedShutdown: doubles.cleanup,
}));

// The text docs/design/worker-pool-local-resume-routing.md fixes for BUILTIN_RESUME_WAITING_REASON.
const BUILTIN_RESUME_WAITING_TEXT = 'Waiting for the builtin worker: this retry resumes a run saved on the daemon machine, and the builtin worker concurrency is 0';
const NO_WORKER_REASON = 'No executable worker is available: worker concurrency is 0';
const ORIGIN = 'https://example.test/repo.git';

let state: TasksFileData;
let warnings: string[];

function resumePoint(): WorkflowResumePoint {
  return { version: 2, stack: [{ workflow: 'default', workflow_ref: 'project:default', step: 'implement', kind: 'agent', occurrence: 1 }],
    iteration: 1, elapsed_ms: 0, workflow_call_invocations: {}, workflow_step_participations: {} };
}

const LOCAL_RESUME_FIELDS = {
  source_run_slug: { source_run_slug: 'old-run', resume_mode: 'retry' },
  start_step: { start_step: 'verify' },
  resume_point: { resume_point: resumePoint() },
} as const satisfies Record<string, Partial<TaskRecord>>;

function pendingRecord(name: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return { name, content: 'work', goal_id: goalRecord().id, status: 'pending', started_at: null, completed_at: null,
    created_at: '2026-11-13T00:00:00Z', ...fields } as TaskRecord;
}

function remoteRetryAssignment(taskName: string) {
  return RemoteAssignmentSchema.parse({ projectId: '/project', taskName, workerId: 'w1', workerName: 'w1',
    registrationGeneration: randomUUID(), requestId: 'r0', executionId: randomUUID(), assignmentGeneration: 1,
    originalSha: 'a'.repeat(40), origin: ORIGIN, branch: 'takt/remote-old', leaseExpiresAt: 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: 'old', retryReservation: true });
}

function useTasks(records: readonly TaskRecord[]): void {
  state = TasksFileSchema.parse({ tasks: records });
  vi.spyOn(TaskStore.prototype, 'read').mockImplementation(() => structuredClone(state));
  vi.spyOn(TaskStore.prototype, 'update').mockImplementation((mutate) => {
    const result = mutate(structuredClone(state));
    if (result !== undefined) state = TasksFileSchema.parse(result);
    return structuredClone(state);
  });
}

/** A pool task the routing must keep on the builtin worker. `PoolTask` gains `builtinOnly` with #209. */
function localResumeTask(origin?: string): PoolTask {
  const task = { projectId: '/project', taskName: 'retry', mergeTask: false, builtinOnly: true, ...(origin === undefined ? {} : { origin }) };
  return task;
}

const project: PoolProject = { projectId: '/project', concurrency: 3 };
const remoteWorker: PoolWorker = { name: 'w1', kind: 'remote', concurrency: 1, registrationGeneration: 'generation' };

beforeEach(() => {
  vi.resetAllMocks();
  doubles.git.mockResolvedValue({ output: Buffer.from(`${ORIGIN}\n`), code: 0, truncated: false });
  doubles.sha.mockResolvedValue('a'.repeat(40));
  doubles.text.mockResolvedValue('b'.repeat(40));
  doubles.goal.mockReturnValue(goalRecord());
  doubles.config.mockReturnValue({ autoRun: true });
  doubles.terminate.mockResolvedValue(undefined);
  doubles.cleanup.mockResolvedValue(undefined);
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

it('keeps a local resume retry off remote workers in the pool schedule', () => {
  const task = localResumeTask(ORIGIN);
  expect(scheduleWorkerPool({ workers: [remoteWorker], projects: [project], pendingTasks: [task], activeAssignments: [] })).toEqual([]);
  const builtin: PoolWorker = { name: 'builtin', kind: 'builtin', concurrency: 1 };
  expect(scheduleWorkerPool({ workers: [remoteWorker, builtin], projects: [project], pendingTasks: [task], activeAssignments: [] }))
    .toEqual([{ projectId: '/project', taskName: 'retry', workerName: 'builtin' }]);
});

it.each(Object.keys(LOCAL_RESUME_FIELDS) as (keyof typeof LOCAL_RESUME_FIELDS)[])(
  'marks a pending retry that resumes a local run as builtin only: %s', async (field) => {
    useTasks([pendingRecord('local retry', LOCAL_RESUME_FIELDS[field]),
      pendingRecord('remote retry', { ...LOCAL_RESUME_FIELDS[field], remote_assignment: remoteRetryAssignment('remote retry') })]);
    const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn());
    try {
      const work = await runtime.inspect();
      if (!('tasks' in work)) throw new Error('Expected a work snapshot');
      const local = work.tasks.find((task) => task.taskName === 'local retry');
      const remote = work.tasks.find((task) => task.taskName === 'remote retry');
      expect(local).toMatchObject({ builtinOnly: true });
      expect(local).not.toHaveProperty('remoteOnly');
      expect(remote).toMatchObject({ remoteOnly: true });
      expect(remote).not.toHaveProperty('builtinOnly');
    } finally { await runtime.close(); }
  });

it('does not assign a local resume retry to a remote claim', async () => {
  useTasks([pendingRecord('T', LOCAL_RESUME_FIELDS.source_run_slug)]);
  const prepareInput = vi.fn();
  const lifecycle = new RemoteTaskLifecycle('/project', new TaskStore('/project'), prepareInput);
  expect(await lifecycle.request({ kind: 'claim', taskName: 'T', workerId: 'w1', registrationGeneration: randomUUID(),
    requestId: 'r1', leaseExpiresAt: 60_000 }, 1)).toEqual({ kind: 'claim', assignment: null });
  expect(state.tasks[0]).toMatchObject({ status: 'pending', source_run_slug: 'old-run', resume_mode: 'retry' });
  expect(state.tasks[0]!.remote_assignment).toBeUndefined();
  expect(prepareInput).not.toHaveBeenCalled();
});

it('explains that a local resume retry waits for the builtin worker when its concurrency is 0', () => {
  expect((scheduler as Record<string, unknown>).BUILTIN_RESUME_WAITING_REASON).toBe(BUILTIN_RESUME_WAITING_TEXT);
  const workers: PoolWorker[] = [{ name: 'builtin', kind: 'builtin', concurrency: 0 }, remoteWorker];
  expect(workerPoolAvailability(localResumeTask(ORIGIN), project, workers, [])).toEqual({ reason: BUILTIN_RESUME_WAITING_TEXT });
  const ordinary: PoolTask = { projectId: '/project', taskName: 'ordinary', mergeTask: false };
  expect(workerPoolAvailability(ordinary, project, workers, [])).toEqual({ reason: NO_WORKER_REASON });
});

it('shows and warns once that a local resume retry waits for the builtin worker', async () => {
  useTasks([pendingRecord('local retry', LOCAL_RESUME_FIELDS.source_run_slug)]);
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn());
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await runtime.setWaitingReasons([{ taskName: 'local retry', reason: BUILTIN_RESUME_WAITING_TEXT }])).toEqual({ kind: 'updated' });
    }
    expect(state.tasks[0]!.waiting_reason).toBe(BUILTIN_RESUME_WAITING_TEXT);
    expect(warnings.filter((line) => line.includes('[WARN]') && line.includes('local retry')
      && line.includes('daemon.builtin_worker.concurrency'))).toHaveLength(1);
  } finally { await runtime.close(); }
});
