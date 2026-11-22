interface SigintRuntime {
  on(event: 'SIGINT', listener: () => void): unknown;
  once(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

export interface CacciaAbortScope {
  signal: AbortSignal;
  dispose(): void;
}

export function waitForCacciaOperation<T>(operation: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) abort();
  });
}

export function createCacciaInactivityScope(callerSignal: AbortSignal | undefined): CacciaAbortScope & {
  progress(): void;
} {
  const controller = new AbortController();
  const signal = callerSignal === undefined ? controller.signal : AbortSignal.any([callerSignal, controller.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', dispose);
  };
  const progress = (): void => {
    clearTimeout(timeout);
    if (disposed || signal.aborted) return;
    timeout = setTimeout(() => controller.abort(new Error('Caccia received no response for 60000 ms')), 60_000);
  };
  signal.addEventListener('abort', dispose, { once: true });
  progress();
  return { signal, progress, dispose };
}

export function createCacciaAbortScope(
  externalSignal?: AbortSignal,
  runtime: SigintRuntime = process,
  onRepeatedSigint?: () => void,
): CacciaAbortScope {
  if (externalSignal !== undefined) {
    return { signal: externalSignal, dispose: () => undefined };
  }

  const controller = new AbortController();
  let receivedSigint = false;
  const onSigint = (): void => controller.abort(new Error('Caccia was interrupted'));
  let onRepeatedSigintHandler: (() => void) | undefined;
  if (onRepeatedSigint !== undefined) {
    const handleRepeatedSigint = (): void => {
      if (!receivedSigint) {
        receivedSigint = true;
        return;
      }
      onRepeatedSigint();
      runtime.removeListener('SIGINT', handleRepeatedSigint);
    };
    onRepeatedSigintHandler = handleRepeatedSigint;
  }
  runtime.once('SIGINT', onSigint);
  if (onRepeatedSigintHandler !== undefined) {
    runtime.on('SIGINT', onRepeatedSigintHandler);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      runtime.removeListener('SIGINT', onSigint);
      if (onRepeatedSigintHandler !== undefined) {
        runtime.removeListener('SIGINT', onRepeatedSigintHandler);
      }
    },
  };
}
