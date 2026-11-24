import { z } from 'zod/v4';

export const TASK_FINISH_HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const TASK_FINISH_HOOK_MAX_TIMEOUT_MS = 60_000;

/** `task_finish_hook` in the project's `.takt/config.yaml`. */
export const TaskFinishHookConfigSchema = z.object({
  /** argv: the first entry is the executable, the rest are literal arguments. No shell is used. */
  command: z.array(z.string().min(1)).min(1),
  timeout_ms: z.number().int().positive().max(TASK_FINISH_HOOK_MAX_TIMEOUT_MS).optional(),
}).strict();

export type TaskFinishHookRawConfig = z.output<typeof TaskFinishHookConfigSchema>;

export interface TaskFinishHookConfig {
  readonly command: readonly [string, ...string[]];
  readonly timeoutMs: number;
}

export function normalizeTaskFinishHook(raw: TaskFinishHookRawConfig | undefined): TaskFinishHookConfig | undefined {
  if (raw === undefined) return undefined;
  const [file, ...args] = raw.command;
  return {
    command: [file!, ...args],
    timeoutMs: raw.timeout_ms ?? TASK_FINISH_HOOK_DEFAULT_TIMEOUT_MS,
  };
}
