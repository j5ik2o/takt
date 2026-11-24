import { z } from 'zod/v4';
import { getErrorMessage } from '../../shared/utils/error.js';
import { GoalQuestionSchema, type GoalQuestion } from '../goals/schema.js';

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
