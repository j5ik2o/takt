import { stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import { getErrorMessage } from '../../shared/utils/error.js';
import { hasCode } from '../daemon/privateFile.js';
import { GoalQuestionSchema, type GoalQuestion } from './schema.js';

export function parseInquiryFile(fileName: string, value: unknown): GoalQuestion {
  const question = GoalQuestionSchema.parse(value);
  if (`${question.id}.json` !== fileName) throw new Error('Question ID differs from its filename');
  return question;
}

/** 保存された本文を含めずに、読めなかった理由だけを返す。JSON と zod の既定の文言は入力の断片を含みうる。 */
export function inquiryFileFailureReason(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code === 'custom' ? issue.message : issue.code}`).join('; ');
  }
  if (error instanceof SyntaxError) return 'invalid JSON';
  return getErrorMessage(error);
}

export class InvalidInquiryFileError extends Error {
  constructor(readonly path: string, error: unknown) {
    super(`Skipped invalid inquiry file ${path}: ${inquiryFileFailureReason(error)}`);
    this.name = 'InvalidInquiryFileError';
  }
}

const MAX_REPORTED_FILES = 256;

/**
 * 読めない問い合わせファイルを、内容が変わるまで 1 回だけ知らせる。
 * 監視は数秒ごとに同じファイルを読み直し、知らせるたびに診断ログが 1 件増えるため、走査をまたいで記録を共有する。
 */
export class InvalidInquiryFileReports {
  private readonly reported = new Map<string, string>();
  constructor(private readonly onError: (error: unknown) => void) {}

  async invalid(path: string, error: unknown): Promise<void> {
    // 列挙のあとに削除された問い合わせは、無いものとして扱う。
    if (hasCode(error, 'ENOENT')) { this.reported.delete(path); return; }
    let stamp = '';
    try {
      const stats = await stat(path);
      stamp = JSON.stringify([stats.ino, stats.size, stats.mtimeMs]);
    } catch (failure) {
      if (hasCode(failure, 'ENOENT')) { this.reported.delete(path); return; }
    }
    if (this.reported.get(path) === stamp) return;
    this.reported.delete(path);
    // 退避や削除で一覧から消えたファイルの記録が残り続けないよう、古いものから捨てる。
    if (this.reported.size >= MAX_REPORTED_FILES) this.reported.delete(this.reported.keys().next().value!);
    this.reported.set(path, stamp);
    this.onError(new InvalidInquiryFileError(path, error));
  }

  /** 読めるようになったファイルは、次に壊れたときにまた知らせる。 */
  valid(path: string): void { this.reported.delete(path); }
}
