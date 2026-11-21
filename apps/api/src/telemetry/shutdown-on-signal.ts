import { constants } from "node:os";

export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5000;

type Signal = "SIGTERM" | "SIGINT";

/** The slice of `process` this module needs, injectable for unit tests. */
export interface SignalProcess {
  once(signal: Signal, listener: () => void): unknown;
  listenerCount(signal: Signal): number;
  kill(pid: number, signal: Signal): unknown;
  exit(code: number): unknown;
  pid: number;
}

export interface ShutdownOnSignalOptions {
  timeoutMs?: number;
  signals?: Signal[];
  proc?: SignalProcess;
}

/** Resolves when `work` settles or after `timeoutMs`, whichever comes first; never rejects. */
export async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flushes telemetry on SIGTERM/SIGINT (AC15) without taking over the process
 * shutdown: the listener is registered with `once`, waits for `shutdown()` at
 * most `timeoutMs`, and then — only if nobody else (e.g. Nest's
 * `enableShutdownHooks`) is listening for that signal — re-raises it so the
 * default action terminates the process exactly as it would without telemetry
 * (falling back to exit code 128 + signal number when the re-raise is ignored).
 */
export function shutdownOnSignal(shutdown: () => Promise<unknown>, options: ShutdownOnSignalOptions = {}): void {
  const proc = options.proc ?? process;
  const timeoutMs = options.timeoutMs ?? TELEMETRY_SHUTDOWN_TIMEOUT_MS;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];

  for (const signal of signals) {
    proc.once(signal, () => {
      void settleWithin(Promise.resolve().then(shutdown), timeoutMs).then(() => {
        if (proc.listenerCount(signal) === 0) {
          proc.kill(proc.pid, signal);
          // As PID 1 (e.g. `exec node` in the container) the kernel ignores a
          // signal with the default action, so exit like the signal would have.
          proc.exit(128 + constants.signals[signal]);
        }
      });
    });
  }
}
