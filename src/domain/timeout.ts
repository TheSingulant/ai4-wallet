export class TimeoutError extends Error {
  readonly timeout = true;

  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

/**
 * Fail closed when work does not settle in time.
 * A late rejection from the original promise is ignored so it cannot surface later.
 * When `abort` is set, the timeout aborts that controller so an in-flight fetch
 * stops instead of only being abandoned.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  abort?: AbortController,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TimeoutError("timed out");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort?.abort();
      reject(new TimeoutError("timed out"));
    }, timeoutMs);
  });
  work.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
