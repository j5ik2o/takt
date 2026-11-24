import { access, mkdir, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { writeFileAtomic } from '../../shared/utils/atomic-file.js';
import { projectIdForCanonicalDirectory } from '../config/global/projectRegistry.js';
import { createLogger } from '../../shared/utils/debug.js';
import { InvalidInquiryFileReports } from './inquiry-files.js';
import { withInquiryLock } from './inquiry-lock.js';
import { createInquiry, answerInquiry, withdrawInquiry } from './inquiry.js';
import { GoalQuestionSchema, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput } from './schema.js';

export type InquiryOwner =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'repository'; readonly repositoryDirectory: string };

const INQUIRIES_DIRECTORY = 'inquiries';
const IdSchema = z.uuid();

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const log = createLogger('standalone-inquiries');
/** 応答へ載せない一覧では、読めないファイルをプロセスの中で 1 回だけログに残す。 */
const loggedInvalidFiles = new InvalidInquiryFileReports((error) => log.warn(error.message));

export class StandaloneInquiryStore {
  /** 一覧は、読めない 1 件を invalidFiles へ知らせて飛ばす。ID を指定した読み書きは、その 1 件のエラーを返す。 */
  constructor(private readonly configDirectory: string, private readonly owner: InquiryOwner,
    private readonly invalidFiles: InvalidInquiryFileReports = loggedInvalidFiles) {}

  async create(input: GoalQuestionInput): Promise<GoalQuestion> {
    return withInquiryLock(this.configDirectory, async () => {
      const question = createInquiry(input);
      const directory = await this.directory();
      const path = join(directory, `${question.id}.json`);
      await this.assertUnusedId(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.write(path, question);
      return question;
    });
  }

  async list(): Promise<GoalQuestion[]> {
    const directory = await this.directory();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const questions: GoalQuestion[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const question = await this.readListed(directory, entry.name);
      if (question !== undefined) questions.push(question);
    }
    return questions;
  }

  async listPending(): Promise<GoalQuestion[]> {
    const directory = await this.directory();
    let entries;
    try { entries = await opendir(directory); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const questions: GoalQuestion[] = [];
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const question = await this.readListed(directory, entry.name);
      if (question?.status === 'pending') questions.push(question);
    }
    return questions;
  }

  async *iteratePending(): AsyncGenerator<GoalQuestion> {
    const directory = await this.directory();
    let entries;
    try { entries = await opendir(directory); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const question = await this.readListed(directory, entry.name);
      if (question?.status === 'pending' && question.recipient === 'human') yield question;
    }
  }

  async get(id: string): Promise<GoalQuestion> {
    return this.read(join(await this.directory(), `${IdSchema.parse(id)}.json`), id);
  }

  async listPendingPage(offset: number, limit: number): Promise<{ inquiries: GoalQuestion[]; totalCount: number }> {
    const directory = await this.directory();
    let entries;
    try { entries = await opendir(directory); }
    catch (error) {
      if (isMissing(error)) return { inquiries: [], totalCount: 0 };
      throw error;
    }
    const candidates: GoalQuestion[] = [];
    const capacity = offset + limit;
    let totalCount = 0;
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const question = await this.readListed(directory, entry.name);
      if (question?.status !== 'pending') continue;
      totalCount++;
      let position = 0;
      let end = candidates.length;
      while (position < end) {
        const middle = Math.floor((position + end) / 2);
        if (candidates[middle]!.id.localeCompare(question.id) < 0) position = middle + 1;
        else end = middle;
      }
      if (position >= capacity) continue;
      if (candidates.length === capacity) candidates.pop();
      candidates.splice(position, 0, question);
    }
    return { inquiries: candidates.slice(offset), totalCount };
  }

  async answer(id: string, answer: string | GoalAnswerInput,
    source: NonNullable<GoalQuestion['answer']>['source'] = 'tui'): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const answered = answerInquiry(await this.read(path, id), answer, source);
    this.write(path, answered);
    return answered;
  }

  async answerForPublication(id: string, answer: string | GoalAnswerInput,
    source: NonNullable<GoalQuestion['answer']>['source'] = 'tui'): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const answered = answerInquiry(await this.read(path, id), answer, source);
    const pending = GoalQuestionSchema.parse({ ...answered, answerPublicationPending: true });
    this.write(path, pending);
    return pending;
  }

  async markAnswerPublished(id: string): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const question = await this.read(path, id);
    if (question.answerPublicationPending !== true) return question;
    const result = GoalQuestionSchema.parse({ ...question, answerPublicationPending: undefined });
    this.write(path, result);
    return result;
  }

  async withdraw(id: string, reason?: string): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const question = await this.read(path, id);
    const withdrawn = withdrawInquiry(question, reason);
    if (withdrawn !== question) this.write(path, withdrawn);
    return withdrawn;
  }

  private async directory(): Promise<string> {
    const directory = this.owner.kind === 'workspace'
      ? join(this.configDirectory, 'workspaces', IdSchema.parse(this.owner.workspaceId))
      : join(this.configDirectory, 'projects', projectIdForCanonicalDirectory(await realpath(this.owner.repositoryDirectory)));
    return join(directory, INQUIRIES_DIRECTORY);
  }

  private async read(path: string, id: string): Promise<GoalQuestion> {
    const question = GoalQuestionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (question.id !== id) throw new Error('Saved question ID differs from its filename');
    return question;
  }

  private async readListed(directory: string, fileName: string): Promise<GoalQuestion | undefined> {
    const path = join(directory, fileName);
    let question;
    try { question = await this.read(path, IdSchema.parse(fileName.slice(0, -'.json'.length))); }
    catch (error) {
      await this.invalidFiles.invalid(path, error);
      return undefined;
    }
    this.invalidFiles.valid(path);
    return question;
  }

  private async assertUnusedId(path: string): Promise<void> {
    try { await access(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      return;
    }
    throw new Error('Question ID already exists');
  }

  private write(path: string, question: GoalQuestion): void {
    const parsed = GoalQuestionSchema.parse(question);
    writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  }
}
