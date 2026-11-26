import type { z } from 'zod';
import { packageVersion } from '../../shared/package-info.js';
import { formatIssuePath } from './issuePath.js';

export function assertValidConfig(
  schema: z.ZodType,
  rawConfig: Record<string, unknown>,
  configPath: string,
  onlyUnrecognizedKeys = false,
): void {
  const parsedResult = schema.safeParse(rawConfig);
  if (parsedResult.success) {
    return;
  }
  const issue = onlyUnrecognizedKeys
    ? parsedResult.error.issues.find((candidate) => candidate.code === 'unrecognized_keys')
    : parsedResult.error.issues[0];
  if (!issue) {
    return;
  }
  throw new Error(formatConfigIssue(issue, configPath));
}

function formatConfigIssue(issue: z.core.$ZodIssue, configPath: string): string {
  const message = `Configuration error: invalid ${formatIssuePath(issue.path)} in ${configPath}: ${issue.message}`;
  if (issue.code !== 'unrecognized_keys') {
    return message;
  }
  const keys = issue.keys.map((key) => `"${formatIssuePath([...issue.path, key])}"`).join(', ');
  const noun = issue.keys.length === 1 ? 'key' : 'keys';
  return `${message}. takt ${packageVersion} does not support ${noun} ${keys}; `
    + 'a newer takt or another build may. Check which takt runs with `command -v takt`.';
}
