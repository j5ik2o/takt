export type WaitForOptions = number | { timeout?: number; interval?: number };
export type WaitFor = <T>(callback: () => T | Promise<T>, options?: WaitForOptions) => Promise<T>;

export function readTestTimeFactor(env?: Record<string, string | undefined>): number;
export const testTimeFactor: number;
export function scaledMs(ms: number, factor?: number): number;
export function scaleWaitForOptions(options: WaitForOptions | undefined, factor?: number): WaitForOptions | undefined;
export function writtenWaitForTimeoutMs(options: WaitForOptions | undefined): number;
export function waitForExpirySuffix(details: { writtenMs: number; factor: number }): string;
export function annotateWaitForTimeout(
  error: unknown,
  details: { writtenMs: number; factor: number },
): unknown;
export function withScaledWaitFor(waitFor: WaitFor, factor?: number): WaitFor;
