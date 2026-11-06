/**
 * Searches in worker threads. `node:sqlite` searches synchronously: in the main thread,
 * one search at a time runs on one core. Each worker opens the index file itself (read-only)
 * and answers searches in parallel; the main thread only parses requests and sends answers.
 */
import { Worker } from 'node:worker_threads';
import {
  IndexUnavailableError,
  type PlaceRow,
  type ReverseOptions,
  type SearchIndex,
  type SearchIndexOptions,
  type SearchOptions,
} from './search-index.js';

export type WorkerRequest =
  | { id: number; op: 'search'; options: SearchOptions }
  | { id: number; op: 'reverse'; options: ReverseOptions }
  | { id: number; op: 'reload' };

/** A request before it gets its id (`Omit` over each member of the union). */
type WorkerCall = WorkerRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'id'>
    : never
  : never;

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: { name: string; message: string; foundSchemaVersion?: number };
    };

/** What the routes need: searches that may run elsewhere. */
export interface SearchBackend {
  search(options: SearchOptions): Promise<PlaceRow[] | null>;
  reverse(options: ReverseOptions): Promise<PlaceRow[] | null>;
  /** After an index swap: `true` if a search now uses another file. */
  reload(): Promise<boolean>;
  close(): Promise<void>;
}

/** Searches in the main thread, on the server's own `SearchIndex`. */
export class InProcessSearch implements SearchBackend {
  constructor(private readonly index: SearchIndex) {}

  search(options: SearchOptions): Promise<PlaceRow[] | null> {
    return run(() => this.index.search(options));
  }

  reverse(options: ReverseOptions): Promise<PlaceRow[] | null> {
    return run(() => this.index.reverse(options));
  }

  /** The server's index is reloaded by the server itself. */
  reload(): Promise<boolean> {
    return Promise.resolve(false);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}

/**
 * The worker script next to this file. From the TypeScript source (tests, `npm run dev`) the
 * worker loads it via tsx; in the built image it is plain JavaScript.
 */
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(`./search-worker.${FROM_SOURCE ? 'ts' : 'js'}`, import.meta.url);
const WORKER_EXEC_ARGV = FROM_SOURCE ? ['--import', 'tsx'] : [];

export class SearchPool implements SearchBackend {
  private readonly slots: Slot[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly path: string,
    size: number,
    private readonly options: SearchIndexOptions = {},
  ) {
    if (size < 1) throw new Error('SearchPool needs at least one worker');
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  get size(): number {
    return this.slots.length;
  }

  search(options: SearchOptions): Promise<PlaceRow[] | null> {
    return this.send(this.leastBusy(), { op: 'search', options }) as Promise<PlaceRow[] | null>;
  }

  reverse(options: ReverseOptions): Promise<PlaceRow[] | null> {
    return this.send(this.leastBusy(), { op: 'reverse', options }) as Promise<PlaceRow[] | null>;
  }

  /**
   * Asks every worker to check the index file and switch to a new one. A worker that has
   * not opened the index yet opens the current file with its next search anyway.
   */
  async reload(): Promise<boolean> {
    const results = await Promise.allSettled(
      this.slots.map((slot) => this.send(slot, { op: 'reload' })),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.some((r) => r.status === 'fulfilled' && r.value === true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL, {
      execArgv: WORKER_EXEC_ARGV,
      workerData: { path: this.path, options: this.options },
    });
    const slot: Slot = { worker, pending: new Map() };
    worker.on('message', (reply: WorkerReply) => {
      const pending = slot.pending.get(reply.id);
      if (!pending) return;
      slot.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(toError(reply.error));
    });
    // A crashed worker: fail its open requests and start a new one in its place.
    const replace = (err: Error) => {
      for (const pending of slot.pending.values()) pending.reject(err);
      slot.pending.clear();
      const i = this.slots.indexOf(slot);
      if (!this.closed && i >= 0) this.slots[i] = this.spawn();
    };
    worker.on('error', replace);
    worker.on('exit', (code) => {
      if (!this.closed) replace(new Error(`Search worker exited with code ${String(code)}`));
    });
    return slot;
  }

  private leastBusy(): Slot {
    let best = this.slots[0] as Slot;
    for (const slot of this.slots) if (slot.pending.size < best.pending.size) best = slot;
    return best;
  }

  private send(slot: Slot, request: WorkerCall): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('SearchPool is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ ...request, id });
    });
  }
}

function toError(error: { name: string; message: string; foundSchemaVersion?: number }): Error {
  if (error.name === 'IndexUnavailableError') {
    return new IndexUnavailableError(error.message, error.foundSchemaVersion);
  }
  const err = new Error(error.message);
  err.name = error.name;
  return err;
}
