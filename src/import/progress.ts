/**
 * Progress messages for the import. On the Germany extract the import takes half an
 * hour, and until then `/api` answers 503; the messages show in the container log which
 * step it is in and how long it will take.
 */

export type Logger = (message: string) => void;

/** Interval between two messages of a long step. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 25568099 → "25,568,099" */
export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/** 192000 → "3 min 12 s"; from one hour on without seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h)} h ${String(min)} min`;
  if (min > 0) return `${String(min)} min ${String(s)} s`;
  return `${String(s)} s`;
}

export interface ProgressOptions {
  /** Total, if known in advance; then with percent and remaining time. */
  total?: number;
  intervalMs?: number;
  now?: () => number;
}

/** Progress of a step, reported at most once per interval. */
export class Progress {
  private readonly total: number | undefined;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly started: number;
  private lastLog: number;

  constructor(
    private readonly log: Logger,
    private readonly label: string,
    options: ProgressOptions = {},
  ) {
    this.total = options.total;
    this.intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.started = this.now();
    this.lastLog = this.started;
  }

  /** `done` units completed; `detail` adds to the message (e.g. "ways"). */
  update(done: number, detail?: string): void {
    const now = this.now();
    if (now - this.lastLog < this.intervalMs) return;
    this.lastLog = now;
    const elapsed = Math.max(1, now - this.started);
    let message: string;
    if (this.total !== undefined && this.total > 0) {
      const percent = Math.min(100, Math.floor((done / this.total) * 100));
      message = `${this.label}: ${formatCount(done)} / ${formatCount(this.total)} (${String(percent)} %)`;
      if (done > 0 && done < this.total) {
        message += `, about ${formatDuration(((this.total - done) * elapsed) / done)} left`;
      }
    } else {
      message = `${this.label}: ${formatCount(done)} (${formatCount((done * 1000) / elapsed)}/s)`;
    }
    if (detail) message += `, currently ${detail}`;
    this.log(message);
  }

  finish(done: number): void {
    this.log(
      `${this.label} done: ${formatCount(done)} in ${formatDuration(this.now() - this.started)}`,
    );
  }
}

export interface StepsOptions {
  /** Number of the first step, e.g. 2 if the download was step 1. */
  first?: number;
  now?: () => number;
}

/** Numbered steps ("Step 2/5: …") with the duration of each step. */
export class Steps {
  private readonly now: () => number;
  private current: number;
  private started: number | null = null;

  constructor(
    private readonly log: Logger,
    private readonly total: number,
    options: StepsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.current = (options.first ?? 1) - 1;
  }

  start(name: string): void {
    this.done();
    this.current++;
    this.started = this.now();
    this.log(`Step ${this.label()}: ${name}`);
  }

  /** Ends the running step; without a running step nothing happens. */
  done(): void {
    if (this.started === null) return;
    this.log(`Step ${this.label()} done in ${formatDuration(this.now() - this.started)}`);
    this.started = null;
  }

  private label(): string {
    return `${String(this.current)}/${String(this.total)}`;
  }
}
