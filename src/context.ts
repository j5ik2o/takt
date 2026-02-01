/**
 * Runtime context shared across modules.
 *
 * Holds process-wide state (quiet mode, etc.) that would otherwise
 * create circular dependencies if exported from cli.ts.
 */

/** Whether quiet mode is active (set during CLI initialization) */
let quietMode = false;

/** Get whether quiet mode is active (CLI flag or config, resolved in preAction) */
export function isQuietMode(): boolean {
  return quietMode;
}

/** Set quiet mode state. Called from CLI preAction hook. */
export function setQuietMode(value: boolean): void {
  quietMode = value;
}
