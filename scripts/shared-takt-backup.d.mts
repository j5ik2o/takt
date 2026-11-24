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
  readonly status: 'copied' | 'empty' | 'absent';
  readonly files: number;
  readonly generation?: string;
}

export interface BackupTotals {
  readonly files: number;
  readonly bytes: number;
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
  readonly env?: NodeJS.ProcessEnv;
  readonly openLogFile?: (dest: string) => Promise<BackupLog>;
  /** Reads the staged manifest back before publishing. Replaceable so that a test can damage what is read. */
  readonly readBack?: (path: string, encoding: 'utf8') => Promise<string>;
}): Promise<GenerationSummary & { readonly pruned: readonly string[] }>;

export function verifyGeneration(input: { readonly dest: string; readonly generation?: string }): Promise<GenerationSummary>;

export function main(
  argv: readonly string[],
  io?: {
    readonly stdout?: { write(text: string): unknown };
    readonly stderr?: { write(text: string): unknown };
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
  },
): Promise<number>;
