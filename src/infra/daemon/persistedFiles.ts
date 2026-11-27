import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod/v4';
import { GoalAnswerSchema, GoalExecutionOriginSchema, GoalIdSchema, GoalQuestionSchema, GoalSchema, GoalTaskResultSchema, type Goal, type GoalQuestion } from '../goals/schema.js';
import { projectIdForCanonicalDirectory } from '../config/global/projectRegistry.js';
import type { ConversationAssignment } from '../conversations/schema.js';
import type { IoOptions } from '../../core/daemon/io.js';
import type { Language } from '../../core/models/types.js';
import { managerTurnFailureNotification } from '../goals/notifications.js';
import { FileAsyncLock } from './lock.js';
import { readDisplayFile } from './displayFiles.js';
import { hasCode, readEntirePrivateFile, readPrivateFile, writePrivateFile } from './privateFile.js';
import { readInboxJson } from './inboxFiles.js';
import { parseInquiryFile, type InvalidInquiryFileReports } from '../goals/inquiry-files.js';

const MAX_PROJECTION_BYTES = 256 * 1024;
// 業務 schema の値 import は run の同期読取まで到達するため、ここでは保存形式だけを検証する。
const tasksFile = z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).strict();
const common = { goalId: GoalIdSchema, createdAt: z.iso.datetime() };
const inboxEvent = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('completion'), taskName: z.string().min(1), runSlug: z.string().min(1).optional(), executionId: z.string().min(1).optional(), result: GoalTaskResultSchema }).strict(),
  z.object({ ...common, kind: z.literal('pr_failed'), expectedSha: z.string(), reason: z.string() }).strict(),
  z.object({ ...common, kind: z.literal('answer'), goalId: GoalIdSchema.nullable(), questionId: z.uuid(),
    questionBody: z.string().optional(), answer: GoalAnswerSchema }).strict(),
  z.object({ ...common, kind: z.enum(['registered', 'patrol']) }).strict(),
  z.object({ ...common, kind: z.literal('resumed'), origin: GoalExecutionOriginSchema.optional() }).strict(),
]);
const inquiryId = z.uuid();
const workspaceRepositories = z.object({ id: z.uuid(), repositoryDirectories: z.array(z.string().refine(isAbsolute)) });

export type DaemonInquiryOwner = Extract<ConversationAssignment, { kind: 'workspace' | 'repository' }>;

/** The identity a pending completion mark is cleared for: every field must still match (#170). */
export interface GoalTaskCompletionIdentity {
  goalId: string;
  taskName: string;
  status: string;
  runSlug?: string;
  executionId?: string;
}

/**
 * Classifies the owner of a `deletion` reservation by whether its process is still there.
 * A live PID without a recorded start time stays `unknown`: PID reuse can never be ruled
 * out for it, so the daemon must neither rewrite the record nor wait for it forever.
 */
export function inspectDeletionOwner(deletion: { owner_pid: number; owner_start_time?: string }): 'alive' | 'dead' | 'unknown' {
  let missing = false;
  try { process.kill(deletion.owner_pid, 0); }
  catch (error) { if (hasCode(error, 'ESRCH')) missing = true; }
  if (missing) return 'dead';
  return deletion.owner_start_time === undefined ? 'unknown' : 'alive';
}

/**
 * Removes the lines of the given keys from one task record in tasks.yaml text, using the
 * parsed document's node ranges to find them. Returns undefined when the record's shape
 * is not the plain block style this surgery understands.
 */
function removeTaskRecordLines(text: string, document: ReturnType<typeof parseDocument>, index: number, keys: readonly string[]): string | undefined {
  const sequence = document.getIn(['tasks'], true) as { items?: unknown[] } | undefined;
  const item = sequence?.items?.[index] as { items?: Array<{ key?: { range?: [number, number, number] }; value?: { range?: [number, number, number] } }> } | undefined;
  if (item === undefined || !Array.isArray(item.items)) return undefined;
  const spans: Array<[number, number]> = [];
  for (const key of keys) {
    const pair = item.items.find((candidate) => {
      const node = candidate.key as { value?: unknown } | undefined;
      return node?.value === key;
    });
    if (pair?.key?.range === undefined || pair?.value?.range === undefined) return undefined;
    const start = text.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
    const endOfValue = pair.value.range[1];
    const newline = text.indexOf('\n', endOfValue);
    spans.push([start, newline === -1 ? text.length : newline + 1]);
  }
  spans.sort((left, right) => right[0] - left[0]);
  let result = text;
  for (const [start, end] of spans) result = result.slice(0, start) + result.slice(end);
  return result;
}

/** 既存形式を小さい読取に限定。大きい goals/tasks の全件解析には使わない。 */
export class DaemonPersistedFiles {
  constructor(private readonly configDirectory: string) {}

  async readWorkspaceInquiry(workspaceId: string, questionId: string) {
    return this.readInquiry({ kind: 'workspace', workspaceId }, questionId);
  }

  /** 読めない 1 件は reports へ知らせて飛ばす。読めない記録は公開もできないため、公開待ちには数えない。 */
  async listPendingInquiryAnswerPublications(owner: DaemonInquiryOwner, reports: InvalidInquiryFileReports) {
    const directory = await this.inquiryDirectory(owner);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const questions: GoalQuestion[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(directory, entry.name);
      let question;
      try { question = await this.readInquiry(owner, entry.name.slice(0, -'.json'.length)); }
      catch (error) {
        await reports.invalid(path, error);
        continue;
      }
      reports.valid(path);
      if (question.answerPublicationPending === true) questions.push(question);
    }
    return questions;
  }

  async markInquiryAnswerPublished(owner: DaemonInquiryOwner, questionId: string) {
    const { path, question } = await this.readInquiryWithPath(owner, questionId);
    if (question.answerPublicationPending !== true) return question;
    const result = GoalQuestionSchema.parse({ ...question, answerPublicationPending: undefined });
    await writePrivateFile(path, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  async readGoal(repositoryDirectory: string, goalId: string) {
    const content = await readPrivateFile(this.goalPath(repositoryDirectory, goalId), MAX_PROJECTION_BYTES);
    if (content === undefined) return undefined;
    const goal = GoalSchema.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (goal.id !== goalId) throw new Error('Stored goal identity mismatch');
    return goal;
  }

  async saveTurnFailure(repositoryDirectory: string, goalId: string, operationId: string, message: string, language: Language): Promise<void> {
    await this.updateGoal(repositoryDirectory, goalId, (goal) => {
      if (goal.notifications?.some((notice) => notice.id === operationId)) return goal;
      const notification = { ...managerTurnFailureNotification(goalId, message, language), id: operationId, recordedAt: new Date().toISOString() };
      return { ...goal, notifications: [...(goal.notifications ?? []), notification] };
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  // GoalStore.update と同じ 2 つのロックファイル（goal.json.lock と goal-execution.lock）を同じ順で取る。
  private async updateGoal(repositoryDirectory: string, goalId: string, transform: (goal: Goal) => Goal, options: IoOptions): Promise<Goal> {
    const path = this.goalPath(repositoryDirectory, goalId);
    const lock = new FileAsyncLock();
    return lock.exclusive(`${path}.lock`, () => lock.exclusive(join(repositoryDirectory, '.takt', 'goal-execution.lock'), async () => {
      const goal = await this.readStoredGoal(path, goalId);
      const updated = transform(goal);
      if (updated === goal) return goal;
      const saved = GoalSchema.parse(updated);
      await writePrivateFile(path, JSON.stringify(saved), options.signal);
      return saved;
    }, options), options);
  }

  private goalPath(repositoryDirectory: string, goalId: string): string {
    return join(repositoryDirectory, '.takt', 'goals', GoalIdSchema.parse(goalId), 'goal.json');
  }

  private async readStoredGoal(path: string, goalId: string): Promise<Goal> {
    const goal = GoalSchema.parse(await readDisplayFile(path));
    if (goal.id !== goalId) throw new Error('Stored goal identity mismatch');
    return goal;
  }

  async readTasks(repositoryDirectory: string) {
    const content = await readPrivateFile(join(repositoryDirectory, '.takt', 'tasks.yaml'), MAX_PROJECTION_BYTES);
    return content === undefined ? { tasks: [] } : tasksFile.parse(parseYaml(content.toString('utf8')) as unknown);
  }

  async inboxDirectory(repositoryDirectory: string): Promise<string> {
    const canonical = await realpath(repositoryDirectory);
    return join(this.configDirectory, 'manager-inbox', createHash('sha256').update(canonical).digest('hex'));
  }

  async readWorkspaceRepositories(workspaceId: string): Promise<readonly string[]> {
    const path = join(this.configDirectory, 'workspaces', inquiryId.parse(workspaceId), 'workspace.json');
    const content = await readPrivateFile(path, MAX_PROJECTION_BYTES);
    if (content === undefined) return [];
    const workspace = workspaceRepositories.parse(JSON.parse(content.toString('utf8')) as unknown);
    if (workspace.id !== workspaceId) throw new Error('Workspace ID differs from its directory');
    return workspace.repositoryDirectories;
  }

  async saveStandaloneInquiryAnswer(repositoryDirectory: string, questionId: string, questionBody: string,
    answer: z.infer<typeof GoalAnswerSchema>): Promise<void> {
    await this.saveAnswerEvent(repositoryDirectory, { kind: 'answer', goalId: null, questionId, questionBody, answer });
  }

  async saveGoalAnswer(repositoryDirectory: string, goalId: string, questionId: string,
    answer: z.infer<typeof GoalAnswerSchema>): Promise<void> {
    // saveManagerEvent と同じく、中止済みのゴールの回答は manager へ知らせない。
    if ((await this.readStoredGoal(this.goalPath(repositoryDirectory, goalId), goalId)).executionStatus === 'aborted') return;
    await this.saveAnswerEvent(repositoryDirectory, { kind: 'answer', goalId, questionId, answer });
  }

  async markGoalAnswerPublished(repositoryDirectory: string, goalId: string, questionId: string): Promise<void> {
    await this.updateGoal(repositoryDirectory, goalId, (goal) => {
      if (goal.questions?.find((question) => question.id === questionId)?.answerPublicationPending !== true) return goal;
      return { ...goal, questions: goal.questions!.map((question) => question.id === questionId
        ? { ...question, answerPublicationPending: undefined } : question) };
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  // 受信箱のファイル名と置き場所は saveManagerEvent と同じ形式にそろえる。
  private async saveAnswerEvent(repositoryDirectory: string, input: Omit<Extract<z.input<typeof inboxEvent>, { kind: 'answer' }>, 'createdAt'>): Promise<void> {
    await this.saveInboxEvent(repositoryDirectory, input);
  }

  private async saveInboxEvent(repositoryDirectory: string, input: Omit<z.input<typeof inboxEvent>, 'createdAt'>): Promise<void> {
    const event = inboxEvent.parse({ ...input, createdAt: new Date().toISOString() });
    const name = `${event.createdAt.replaceAll(':', '-')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}.json`;
    await writePrivateFile(join(await this.inboxDirectory(repositoryDirectory), name), JSON.stringify(event));
  }

  /** Writes one pending goal task completion to the manager inbox, in the saveManagerEvent format (#170). */
  async saveGoalTaskCompletion(repositoryDirectory: string, input: {
    goalId: string; taskName: string; runSlug?: string; executionId?: string;
    result: z.infer<typeof GoalTaskResultSchema>;
  }): Promise<void> {
    await this.saveInboxEvent(repositoryDirectory, { kind: 'completion', ...input });
  }

  /**
   * Clears one pending completion mark from tasks.yaml with a minimal YAML rewrite (#170):
   * only the mark (and a dead owner's `deletion` reservation) is removed, every other record,
   * column, comment and formatting stays as it was. Returns false without rewriting when no
   * record matches all identity conditions, or when a live or unknown deletion owner guards it.
   */
  async markGoalTaskCompletionPublished(repositoryDirectory: string, identity: GoalTaskCompletionIdentity): Promise<boolean> {
    const path = join(repositoryDirectory, '.takt', 'tasks.yaml');
    const lock = new FileAsyncLock();
    return lock.exclusive(`${path}.lock`, async () => {
      const content = await readEntirePrivateFile(path);
      if (content === undefined) return false;
      const document = parseDocument(content.toString('utf8'));
      if (document.errors.length > 0) return false;
      const value = document.toJS({ maxAliasCount: 0 }) as { tasks?: unknown } | null;
      if (value === null || typeof value !== 'object' || !Array.isArray(value.tasks)) return false;
      const index = value.tasks.findIndex((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const record = entry as Record<string, unknown>;
        return record.name === identity.taskName
          && record.goal_id === identity.goalId
          && record.status === identity.status
          && record.run_slug === identity.runSlug
          && record.execution_id === identity.executionId
          && record.completion_publication_pending === true;
      });
      if (index === -1) return false;
      const record = value.tasks[index] as Record<string, unknown>;
      let removeDeletion = false;
      if (record.deletion !== undefined) {
        const deletion = record.deletion as Record<string, unknown> | null;
        if (deletion === null || typeof deletion !== 'object'
          || typeof deletion.owner_pid !== 'number' || !Number.isInteger(deletion.owner_pid) || deletion.owner_pid <= 0
          || (deletion.owner_start_time !== undefined && typeof deletion.owner_start_time !== 'string')) return false;
        const owner = inspectDeletionOwner({
          owner_pid: deletion.owner_pid,
          ...(typeof deletion.owner_start_time === 'string' ? { owner_start_time: deletion.owner_start_time } : {}),
        });
        if (owner !== 'dead') return false;
        removeDeletion = true;
      }
      // Remove only the mark's own lines from the original text, so every other record,
      // column, comment and spacing stays byte-for-byte as it was.
      const text = content.toString('utf8');
      const rewritten = removeTaskRecordLines(text, document, index, removeDeletion
        ? ['completion_publication_pending', 'deletion'] : ['completion_publication_pending']);
      if (rewritten === undefined) {
        document.deleteIn(['tasks', index, 'completion_publication_pending']);
        if (removeDeletion) document.deleteIn(['tasks', index, 'deletion']);
        await writePrivateFile(path, document.toString());
        return true;
      }
      await writePrivateFile(path, rewritten);
      return true;
    }, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  async readInboxEvent(repositoryDirectory: string, name: string) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error('Invalid inbox event filename');
    const path = join(await this.inboxDirectory(repositoryDirectory), name);
    let value;
    try { value = await readInboxJson(path); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    return inboxEvent.parse(value);
  }

  private async inquiryDirectory(owner: DaemonInquiryOwner): Promise<string> {
    const base = owner.kind === 'workspace'
      ? join(this.configDirectory, 'workspaces', inquiryId.parse(owner.workspaceId))
      : join(this.configDirectory, 'projects', projectIdForCanonicalDirectory(await realpath(owner.repositoryDirectory)));
    return join(base, 'inquiries');
  }

  private async readInquiry(owner: DaemonInquiryOwner, questionId: string) {
    return (await this.readInquiryWithPath(owner, questionId)).question;
  }

  private async readInquiryWithPath(owner: DaemonInquiryOwner, questionId: string) {
    const id = inquiryId.parse(questionId);
    const path = join(await this.inquiryDirectory(owner), `${id}.json`);
    return { path, question: parseInquiryFile(`${id}.json`, JSON.parse(await readFile(path, 'utf8')) as unknown) };
  }
}
