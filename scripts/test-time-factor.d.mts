export type WaitForOptions = number | { timeout?: number; interval?: number };
export type WaitFor = <T>(callback: () => T | Promise<T>, options?: WaitForOptions) => Promise<T>;

export function readTestTimeFactor(env?: Record<string, string | undefined>): number;
export const testTimeFactor: number;
export function scaledMs(ms: number, factor?: number): number;
export function scaleWaitForOptions(options: WaitForOptions | undefined, factor?: number): WaitForOptions | undefined;
export function withScaledWaitFor(waitFor: WaitFor, factor?: number): WaitFor;
