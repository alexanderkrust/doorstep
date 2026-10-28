import { nextRun, parseCron } from './cron.js';

/** Größte Verzögerung, die setTimeout zuverlässig kann (2^31-1 ms, ~24,8 Tage). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface ScheduledJob {
  /** Nächster geplanter Lauf; `null` nach `stop()`. */
  next(): Date | null;
  stop(): void;
}

/**
 * Führt `task` nach dem Cron-Ausdruck aus. Läuft die Aufgabe beim nächsten
 * Zeitpunkt noch, wird dieser ausgelassen. Fehler gehen an `onError`, der
 * Zeitplan läuft weiter.
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
    // Lange Wartezeiten in Etappen: noch nicht fällig → weiter warten.
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
