export declare const CONFIG_TARGETS: readonly string[];
export declare const MANAGED_PROVIDER_TARGETS: readonly string[];
export declare const DEFAULT_KEEP: number;

export declare class BackupError extends Error {
  readonly code: string;
  readonly path?: string;
  constructor(code: string, message: string, path?: string);
}

export interface BackupTarget {
  readonly name: string;
  readonly kind: 'config' | 'managed-provider';
  /** `copied`: the generation holds at least one file of the target. */
  readonly status: 'copied' | 'link' | 'empty' | 'absent';
  readonly files: number;
  readonly generation?: string;
}

export interface BackupTotals {
  readonly files: number;
  readonly bytes: number;
  readonly externalLinks: number;
}

export interface GenerationSummary {
  readonly generation: string;
  readonly targets: readonly BackupTarget[];
  readonly totals: BackupTotals;
}

export interface BackupLog {
  write(record: { readonly result: string }): Promise<unknown>;
  close(): Promise<unknown>;
}

export function listGenerations(dest: string): Promise<string[]>;

export function backupSharedTakt(input: {
  readonly source: string;
  readonly dest: string;
  readonly keep?: number;
  readonly acceptRemoved?: boolean;
  readonly now?: Date;
  readonly openLogFile?: (dest: string) => Promise<BackupLog>;
}): Promise<GenerationSummary & { readonly pruned: readonly string[] }>;

export function verifyGeneration(input: { readonly dest: string; readonly generation?: string }): Promise<GenerationSummary>;

export function restoreGeneration(input: {
  readonly dest: string;
  readonly generation?: string;
  readonly to: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<GenerationSummary>;

export interface BuiltTakt {
  readonly loadConfig: () => void;
  readonly inspectProvider: (provider: string) => Promise<{ readonly state: 'missing' | 'stale' | 'ready' }>;
}

export function checkRestoredConfigDirectory(input: {
  readonly dest: string;
  readonly generation?: string;
  readonly configDirectory: string;
  readonly taktRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly importTakt?: (taktRoot: string) => Promise<BuiltTakt>;
}): Promise<{ generation: string; restored: string; config: string; providers: Record<string, string>; ok: boolean }>;

export function main(
  argv: readonly string[],
  io?: {
    readonly stdout?: { write(text: string): unknown };
    readonly stderr?: { write(text: string): unknown };
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
  },
): Promise<number>;
