/**
 * Stand-in for `src/search/search-worker.ts` in tests of the pool's limits: every search and
 * reverse search blocks the thread for `SLOW_SEARCH_MS`, then returns no hits.
 */
import { parentPort } from 'node:worker_threads';
import type { WorkerReply, WorkerRequest } from '../../src/search/search-pool.js';

export const SLOW_SEARCH_MS = 300;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.op !== 'reload') Atomics.wait(sleeper, 0, 0, SLOW_SEARCH_MS);
  const reply: WorkerReply = {
    id: request.id,
    ok: true,
    result: request.op === 'reload' ? false : [],
  };
  parentPort?.postMessage(reply);
});
