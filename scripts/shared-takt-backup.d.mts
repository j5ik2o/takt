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
  readonly status: 'copied' | 'absent';
  readonly generation?: string;
}

export interface BackupTotals {
  readonly files: number;
  readonly bytes: number;
  readonly linkedFiles: number;
  readonly externalLinks: number;
  readonly skippedSpecial: number;
}

export interface GenerationSummary {
  readonly generation: string;
  readonly targets: readonly BackupTarget[];
  readonly totals: BackupTotals;
}

export function listGenerations(dest: string): Promise<string[]>;

export function backupSharedTakt(input: {
  readonly source: string;
  readonly dest: string;
  readonly keep?: number;
  readonly acceptRemoved?: boolean;
  readonly now?: Date;
}): Promise<GenerationSummary & { readonly pruned: readonly string[] }>;

export function verifyGeneration(input: { readonly dest: string; readonly generation?: string }): Promise<GenerationSummary>;

export function restoreGeneration(input: {
  readonly dest: string;
  readonly generation?: string;
  readonly to: string;
}): Promise<GenerationSummary>;

export interface BuiltTakt {
  readonly loadConfig: () => void;
  readonly providers: readonly string[];
  readonly inspectProvider: (provider: string) => Promise<{ readonly state: 'missing' | 'stale' | 'ready' }>;
}

export function checkRestoredConfigDirectory(input: {
  readonly configDirectory: string;
  readonly taktRoot: string;
  readonly importTakt?: (taktRoot: string) => Promise<BuiltTakt>;
}): Promise<{ config: string; providers: Record<string, string>; ok: boolean }>;

export function main(
  argv: readonly string[],
  io?: {
    readonly stdout?: { write(text: string): unknown };
    readonly stderr?: { write(text: string): unknown };
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => Date;
  },
): Promise<number>;
