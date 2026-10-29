import { nextRun, parseCron } from './cron.js';

/** Largest delay setTimeout handles reliably (2^31-1 ms, ~24.8 days). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface ScheduledJob {
  /** Next scheduled run; `null` after `stop()`. */
  next(): Date | null;
  stop(): void;
}

/**
 * Runs `task` according to the cron expression. If the task is still running at the
 * next point in time, that run is skipped. Errors go to `onError`; the schedule
 * keeps running.
 */
export function scheduleCron(
  expression: string,
  task: () => Promise<void>,
  onError: (err: unknown) => void = () => undefined,
): ScheduledJob {
  const schedule = parseCron(expression);
  let timer: NodeJS.Timeout | undefined;
  let due: Date | null = null;
  let running = false;

  const arm = () => {
    if (due === null) return;
    const delay = Math.min(due.getTime() - Date.now(), MAX_TIMEOUT_MS);
    timer = setTimeout(fire, Math.max(0, delay));
    timer.unref();
  };

  const plan = () => {
    due = nextRun(schedule, new Date());
    arm();
  };

  function fire() {
    if (due === null) return;
    // Long waits in stages: not due yet → keep waiting.
    if (Date.now() < due.getTime()) {
      arm();
      return;
    }
    if (!running) {
      running = true;
      task()
        .catch(onError)
        .finally(() => {
          running = false;
        });
    }
    plan();
  }

  plan();
  return {
    next: () => due,
    stop: () => {
      clearTimeout(timer);
      due = null;
    },
  };
}
