import { afterEach, describe, expect, it } from 'vitest';
import {
  SearchOverloadedError,
  SearchPool,
  SearchTimeoutError,
} from '../../src/search/search-pool.js';
import { SLOW_SEARCH_MS } from '../helpers/slow-search-worker.js';

const SLOW_WORKER = new URL('../helpers/slow-search-worker.ts', import.meta.url);
const QUERY = { q: 'Kö', limit: 1 };

let pool: SearchPool | undefined;

afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe('SearchPool limits', () => {
  it('rejects a search that takes longer than the timeout', async () => {
    pool = new SearchPool('/unused.sqlite', 1, { workerUrl: SLOW_WORKER, timeoutMs: 50 });
    const started = performance.now();
    await expect(pool.search(QUERY)).rejects.toThrow(SearchTimeoutError);
    expect(performance.now() - started).toBeLessThan(SLOW_SEARCH_MS);
  });

  it('answers within the timeout as usual', async () => {
    pool = new SearchPool('/unused.sqlite', 1, {
      workerUrl: SLOW_WORKER,
      timeoutMs: SLOW_SEARCH_MS * 10,
    });
    await expect(pool.reverse({ lat: 51, lon: 6, limit: 1, radiusKm: 1 })).resolves.toEqual([]);
  });

  it('counts a timed-out search as pending until the worker is done with it', async () => {
    pool = new SearchPool('/unused.sqlite', 1, {
      workerUrl: SLOW_WORKER,
      timeoutMs: 50,
      queueLimit: 1,
    });
    await expect(pool.search(QUERY)).rejects.toThrow(SearchTimeoutError);
    // The worker is still busy with the first search, so the queue is full.
    await expect(pool.search(QUERY)).rejects.toThrow(SearchOverloadedError);
  });

  it('rejects searches right away when every worker queue is full', async () => {
    const busy = new SearchPool('/unused.sqlite', 2, { workerUrl: SLOW_WORKER, queueLimit: 2 });
    pool = busy;
    const accepted = Array.from({ length: 4 }, () => busy.search(QUERY));
    const started = performance.now();
    await expect(busy.search(QUERY)).rejects.toThrow(SearchOverloadedError);
    expect(performance.now() - started).toBeLessThan(SLOW_SEARCH_MS);
    // The accepted ones still get their answer.
    expect(await Promise.all(accepted)).toEqual([[], [], [], []]);
  });

  it('does not limit reloads', async () => {
    pool = new SearchPool('/unused.sqlite', 1, {
      workerUrl: SLOW_WORKER,
      timeoutMs: 50,
      queueLimit: 1,
    });
    const search = pool.search(QUERY).catch(() => null);
    await expect(pool.reload()).resolves.toBe(false);
    await search;
  });

  it('fails pending searches on close', async () => {
    pool = new SearchPool('/unused.sqlite', 1, { workerUrl: SLOW_WORKER });
    const pending = expect(pool.search(QUERY)).rejects.toThrow(/closed/);
    await pool.close();
    await pending;
  });
});
