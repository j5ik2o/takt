/**
 * After the daemon saved the terminal record of a remote execution, a failing step that follows the
 * save (the manager notification, or the live intervention terminal record) must not keep the reply
 * from the worker: the remote worker runtime updates its records, releases the assignment, and
 * answers `completed` on the same connection (#195-#197, 6節).
 * Design: docs/design/worker-pool-completion-publication.md, docs/design/193-worker-pool-requests.md (S22).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteWorkerRuntime } from '../features/workerPool/remoteWorkerRuntime.js';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { TasksFileSchema, type TasksFileData } from '../infra/task/schema.js';
import { WorkerRejectedError, executionIdentity, type RemoteProjectRequest, type RemoteTaskRecord, type WorkerRegistration,
  type WorkerRequest, type WorkerResponse } from '../core/worker-pool/remoteProtocol.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({
  workers: new Map<string, { registration: WorkerRegistration; registered: boolean }>(), files: new Map<string, Buffer>(),
  git: vi.fn(), sha: vi.fn(), text: vi.fn(), goal: vi.fn(), updateGoal: vi.fn(), event: vi.fn(),
  issued: { total: 0 }, recordTerminal: vi.fn(),
}));
vi.mock('../infra/daemon/privateFile.js', () => ({
  readPrivateFile: async (path: string) => doubles.files.get(path),
  writePrivateFile: async (path: string, bytes: string) => { doubles.files.set(path, Buffer.from(bytes)); },
}));
vi.mock('../infra/worker-pool/workerRegistry.js', () => ({ WORKER_PULL_RESPONSES_DIRECTORY: 'worker-pull-responses', WorkerRegistry: class {
  list() { return Promise.resolve([...doubles.workers.values()].filter((worker) => worker.registered).map((worker) => structuredClone(worker.registration))); }
  async authorize<T>(token: string, action: (registration: WorkerRegistration) => Promise<T>) {
    const worker = doubles.workers.get(token);
    if (worker === undefined || !worker.registered) throw new WorkerRejectedError('Worker registration was removed');
    return action(structuredClone(worker.registration));
  }
} }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git, resolveGoalBranchSha: doubles.sha, goalGitText: doubles.text }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; update = doubles.updateGoal; } }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
vi.mock('../infra/workflow/live-intervention-store.js', () => ({ LiveInterventionFileStore: class {
  read() { return { issuedTotal: doubles.issued.total, instructions: [] }; }
  recordTerminal = doubles.recordTerminal;
} }));

beforeEach(() => {
  vi.clearAllMocks();
  doubles.workers.clear(); doubles.files.clear();
  doubles.issued.total = 0;
  doubles.git.mockResolvedValue({ output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false });
  doubles.sha.mockResolvedValue('a'.repeat(40));
  doubles.text.mockResolvedValue('b'.repeat(40));
  doubles.goal.mockReturnValue(goalRecord());
  doubles.recordTerminal.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  let state: TasksFileData = TasksFileSchema.parse({ tasks: [{ name: 'T', content: 'work', goal_id: goalRecord().id,
    status: 'pending', started_at: null, completed_at: null, created_at: '2026-11-13T00:00:00Z' }] });
  const store = new TaskStore('/project');
  vi.spyOn(store, 'read').mockImplementation(() => structuredClone(state));
  vi.spyOn(store, 'update').mockImplementation((mutate) => {
    const result = mutate(structuredClone(state));
    if (result !== undefined) state = TasksFileSchema.parse(result);
    return structuredClone(state);
  });
  const lifecycle = new RemoteTaskLifecycle('/project', store, vi.fn());
  const pending = ['T'];
  const pool = {
    setRemoteWorkers: vi.fn(), dispatch: vi.fn(async () => {}), restore: vi.fn(async () => {}),
    remoteRecords: () => lifecycle.records(), hasProjectSnapshot: () => true, hasCompleteSnapshot: () => true,
    project: vi.fn((projectId: string) => projectId === '/project' ? ({ inspect: async () => ({ concurrency: 1, available: true, tasks: [] }),
      remote: async (request: RemoteProjectRequest) => {
        const result = await lifecycle.request(request, 1);
        if (result.kind === 'unreadable') throw new Error('Unexpected unreadable remote input');
        return result;
      },
      start: async () => ({ kind: 'declined' as const }), setWaitingReasons: async () => ({ kind: 'updated' as const }), close: async () => {} }) : undefined),
    pull: vi.fn((workerName: string) => pending[0] === undefined ? undefined : { projectId: '/project', taskName: pending.shift()!, workerName }),
    decline: vi.fn(), release: vi.fn(), close: async () => {},
    get activeTaskCount() { return lifecycle.records().filter((record) => record.status === 'running').length; },
  };
  const token = 'test-w1';
  const registration = { name: 'w1', registrationGeneration: randomUUID(), concurrency: 1, tokenHash: 'a'.repeat(64) };
  doubles.workers.set(token, { registration, registered: true });
  const messages: WorkerResponse[] = [];
  const sink = { send: (response: WorkerResponse) => { messages.push(response); }, close: vi.fn(), fail: vi.fn() };
  const message = <T extends object>(body: T) => ({ protocolVersion: 1 as const, requestId: randomUUID() as string,
    workerId: 'w1', registrationGeneration: registration.registrationGeneration, ...body });
  const runtime = new RemoteWorkerRuntime({ directory: '/config', dispatcher: pool, version: '1.0', now: () => 1000 });
  const send = (request: WorkerRequest) => runtime.receive(token, request, sink);
  return { runtime, pool, messages, sink, message, send, state: () => state };
}

it.each(['notification', 'intervention terminal'] as const)(
  'updates the remote records and releases the assignment when a step after the save fails: %s', async (step) => {
    const f = fixture();
    try {
      await f.runtime.restore();
      await f.send(f.message({ kind: 'connect' as const, version: '1.0', canExecute: true, active: [] }));
      await f.send(f.message({ kind: 'pull' as const }));
      const assigned = f.messages.find((response) => response.kind === 'assignment');
      if (assigned?.kind !== 'assignment' || assigned.assignment === null) throw new Error('Expected a remote assignment');
      const assignment = executionIdentity(assigned.assignment);
      if (step === 'notification') doubles.event.mockImplementation(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
      else {
        doubles.issued.total = 1;
        doubles.recordTerminal.mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      const outcome = await f.send(f.message({ kind: 'complete' as const, assignment, success: false, reason: 'Provider failed' }))
        .then(() => 'replied', (error: unknown) => error);
      expect(outcome).toBe('replied');
      expect(f.state().tasks[0]).toMatchObject({ status: 'failed', execution_id: assignment.executionId });
      expect(f.messages.at(-1)).toMatchObject({ kind: 'completed', accepted: true });
      expect(f.pool.release).toHaveBeenCalledWith(expect.objectContaining({ executionId: assignment.executionId }));
      // The runtime keeps its own copy of the records it dispatches by (remoteWorkerRuntime.ts updateRecord).
      const records = (f.runtime as unknown as { records: RemoteTaskRecord[] }).records;
      expect(records.find((record) => record.assignment.executionId === assignment.executionId)?.status).toBe('failed');
      expect(f.sink.fail).not.toHaveBeenCalled();
      expect(f.sink.close).not.toHaveBeenCalled();
    } finally { await f.runtime.close(); }
  });
