import fs from 'node:fs';
import { join } from 'node:path';

const [projectDir, resultFile] = process.argv.slice(2);
if (!projectDir || !resultFile) throw new Error('Missing claim worker arguments');

const { TaskRunner } = await import('../../infra/task/runner.js');

let outcome: { claimed?: string[]; error?: string; errorName?: string; code?: unknown; causeMessage?: string };
try {
  const claimed = new TaskRunner(projectDir).claimNextTasks(1);
  outcome = { claimed: claimed.map(({ name }) => name) };
} catch (error) {
  const typed = error as Error & { code?: unknown; cause?: unknown };
  outcome = {
    error: String(typed?.message ?? error),
    errorName: typed?.constructor?.name,
    code: typed?.code,
    causeMessage: typed?.cause instanceof Error ? typed.cause.message : undefined,
  };
}
fs.writeFileSync(resultFile, JSON.stringify(outcome));
