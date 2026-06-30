// Defense-in-depth for git lock contention. The in-process checkout mutex removes
// same-process races, but a stale lock or an external/cross-process git on the same
// tree can still transiently fail with a lock error. These are safe to retry: the
// holder releases its lock in moments, and the operation is idempotent on retry.
const LOCK_ERROR = /index\.lock|could not lock|cannot lock ref|unable to create[^\n]*\.lock/i;

export function isTransientGitLockError(message: string): boolean {
  return LOCK_ERROR.test(message);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withGitRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; backoffMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 100;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !isTransientGitLockError(message)) {
        throw error;
      }
      // Linear backoff; lock holders release within a tick or two in practice.
      await delay(backoffMs * attempt);
    }
  }
}
