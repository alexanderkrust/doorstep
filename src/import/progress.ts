/**
 * Fortschrittsmeldungen für den Import. Der Import dauert auf dem Deutschland-Extrakt
 * eine halbe Stunde, und bis dahin antwortet `/api` mit 503; die Meldungen zeigen im
 * Container-Log, in welchem Schritt er steckt und wie lange es noch dauert.
 */

export type Logger = (message: string) => void;

/** Abstand zwischen zwei Meldungen eines langen Schritts. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

const NUMBER = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** 25568099 → "25.568.099" */
export function formatCount(n: number): string {
  return NUMBER.format(n);
}

/** 192000 → "3 min 12 s"; ab einer Stunde ohne Sekunden. */
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
  /** Gesamtzahl, falls vorab bekannt; dann mit Prozent und Restzeit. */
  total?: number;
  intervalMs?: number;
  now?: () => number;
}

/** Fortschritt eines Schritts, gemeldet höchstens einmal je Intervall. */
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

  /** `done` Einheiten erledigt; `detail` ergänzt die Meldung (z. B. "Wege"). */
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
        message += `, noch ca. ${formatDuration(((this.total - done) * elapsed) / done)}`;
      }
    } else {
      message = `${this.label}: ${formatCount(done)} (${formatCount((done * 1000) / elapsed)}/s)`;
    }
    if (detail) message += `, gerade ${detail}`;
    this.log(message);
  }

  finish(done: number): void {
    this.log(
      `${this.label} fertig: ${formatCount(done)} in ${formatDuration(this.now() - this.started)}`,
    );
  }
}

export interface StepsOptions {
  /** Nummer des ersten Schritts, z. B. 2, wenn der Download Schritt 1 war. */
  first?: number;
  now?: () => number;
}

/** Nummerierte Schritte ("Schritt 2/5: …") mit der Dauer jedes Schritts. */
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
    this.log(`Schritt ${this.label()}: ${name}`);
  }

  /** Beendet den laufenden Schritt; ohne laufenden Schritt passiert nichts. */
  done(): void {
    if (this.started === null) return;
    this.log(`Schritt ${this.label()} fertig in ${formatDuration(this.now() - this.started)}`);
    this.started = null;
  }

  private label(): string {
    return `${String(this.current)}/${String(this.total)}`;
  }
}
