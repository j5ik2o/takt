import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { RemoteAssignmentSchema } from '../../core/worker-pool/remoteProtocol.js';
import { GoalTaskResultSchema, type GoalTaskResult } from '../goals/schema.js';
import { hasCode, readEntirePrivateFile } from '../daemon/privateFile.js';

export const TASKS_FILE_NAME = 'tasks.yaml';

// 業務側の巨大な schema 依存は持ち込まず、観測に使う列だけを検証する。
const WatchTaskSchema = z.object({
  name: z.string().min(1), status: z.enum(['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed']),
  goal_id: z.uuid().optional(), run_slug: z.string().min(1).optional(), execution_id: z.string().min(1).optional(),
  worktree_path: z.string().optional(), task_dir: z.string().optional(),
  merge_task: z.boolean().optional(),
  waiting_reason: z.string().optional(), remote_assignment: RemoteAssignmentSchema.optional(),
  owner_pid: z.number().int().positive().nullable().optional(), owner_start_time: z.string().min(1).nullable().optional(),
  created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(),
});
const TasksSchema = z.object({ tasks: z.array(WatchTaskSchema) });
export type WatchTask = z.infer<typeof WatchTaskSchema>;

export async function readWatchTasks(cwd: string): Promise<readonly WatchTask[]> {
  const path = join(cwd, '.takt', TASKS_FILE_NAME);
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe tasks.yaml');
  const text = await readFile(path, 'utf8');
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  return TasksSchema.parse(document.toJS({ maxAliasCount: 0 })).tasks;
}

export async function hasTaskDirectory(repositoryDirectory: string, directory: string): Promise<boolean> {
  const target = resolve(repositoryDirectory, directory);
  const tasks = await readWatchTasks(repositoryDirectory);
  return tasks.some((task) => task.task_dir !== undefined
    && resolve(repositoryDirectory, task.task_dir) === target);
}

export const WatchTaskDeletionSchema = z.object({
  id: z.uuid(),
  owner_pid: z.number().int().positive(),
  owner_start_time: z.string().min(1).optional(),
});
export type WatchTaskDeletion = z.infer<typeof WatchTaskDeletionSchema>;

/** A saved goal task completion whose manager notice is still unpublished (#170). */
export interface PendingGoalTaskCompletion {
  name: string;
  goalId: string;
  status: 'completed' | 'failed' | 'exceeded' | 'pr_failed';
  completion: GoalTaskResult;
  runSlug?: string;
  executionId?: string;
  deletion?: WatchTaskDeletion;
}

/** The report record shared by the daemon's watch tick and `hasWork`: one report per unchanged record. */
export interface PendingCompletionReports {
  invalid(key: string, error: unknown): Promise<void> | void;
  valid(key: string): void;
}

const PendingGoalTaskCompletionSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['completed', 'failed', 'exceeded', 'pr_failed']),
  goal_id: z.uuid(),
  completion: GoalTaskResultSchema,
  run_slug: z.string().min(1).optional(),
  execution_id: z.string().min(1).optional(),
  deletion: WatchTaskDeletionSchema.optional(),
}).refine((value) => value.run_slug !== undefined || value.execution_id !== undefined, {
  message: 'A pending completion needs a run_slug or an execution_id.',
});

function recordName(record: unknown, index: number): string {
  if (typeof record === 'object' && record !== null && 'name' in record) {
    const name = (record as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return `index-${index}`;
}

/**
 * Reads only the records marked `completion_publication_pending: true` from tasks.yaml (#170).
 * A record whose mark is not `true` is skipped without its completion being parsed; a `true`
 * mark whose content is invalid is reported once (per unchanged content) and skipped, so one
 * bad record never stops the valid pending completions in the same file. A file that cannot
 * be read at all is reported once and yields no completions.
 */
export async function readPendingGoalTaskCompletions(
  repositoryDirectory: string,
  reports: PendingCompletionReports,
): Promise<readonly PendingGoalTaskCompletion[]> {
  const path = join(repositoryDirectory, '.takt', TASKS_FILE_NAME);
  let text: string;
  try {
    const content = await readEntirePrivateFile(path);
    if (content === undefined) return [];
    text = content.toString('utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    await reports.invalid(`${path}##file`, new Error(`Cannot read pending goal task completions from ${path}: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
  let rawTasks: unknown;
  try {
    const document = parseDocument(text);
    if (document.errors.length > 0) throw document.errors[0];
    const value = document.toJS({ maxAliasCount: 0 }) as { tasks?: unknown } | null;
    if (value === null || typeof value !== 'object' || !Array.isArray(value.tasks)) {
      throw new Error('tasks.yaml does not hold a tasks list');
    }
    rawTasks = value.tasks;
  } catch (error) {
    await reports.invalid(`${path}##file`, new Error(`Cannot read pending goal task completions from ${path}: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
  const completions: PendingGoalTaskCompletion[] = [];
  const records = rawTasks as unknown[];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (typeof record !== 'object' || record === null) continue;
    if ((record as Record<string, unknown>).completion_publication_pending !== true) continue;
    const name = recordName(record, index);
    const parsed = PendingGoalTaskCompletionSchema.safeParse(record);
    if (!parsed.success) {
      const stamp = createHash('sha256').update(JSON.stringify(record)).digest('hex');
      await reports.invalid(`${path}#${name}#${stamp}`,
        new Error(`Skipped an invalid pending goal task completion in ${path} for task ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`));
      continue;
    }
    reports.valid(`${path}#${name}`);
    const value = parsed.data;
    completions.push({
      name: value.name,
      goalId: value.goal_id,
      status: value.status,
      completion: value.completion,
      ...(value.run_slug === undefined ? {} : { runSlug: value.run_slug }),
      ...(value.execution_id === undefined ? {} : { executionId: value.execution_id }),
      ...(value.deletion === undefined ? {} : { deletion: value.deletion }),
    });
  }
  return completions;
}
