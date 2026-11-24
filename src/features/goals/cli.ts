import type { Readable } from 'node:stream';
import { createGoal } from '../../infra/goals/service.js';
import { GoalCreateInputSchema, type Goal } from '../../infra/goals/schema.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';

export interface GoalRegisterOptions {
  input: string;
}

export interface GoalRegisterDependencies {
  readFile: (path: string) => Promise<string>;
}

async function readAll(stream: Readable): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : String(chunk);
  }
  return text;
}

export async function runGoalRegister(
  cwd: string,
  options: GoalRegisterOptions,
  stdin: Readable,
  dependencies: GoalRegisterDependencies,
): Promise<Goal> {
  const repositoryDirectory = await resolveGitRepositoryDirectory(cwd);
  const text = options.input === '-' ? await readAll(stdin) : await dependencies.readFile(options.input);
  const raw: unknown = JSON.parse(text);
  const input = GoalCreateInputSchema.parse({ ...(raw as Record<string, unknown>), cwd: repositoryDirectory });
  return createGoal(input);
}
