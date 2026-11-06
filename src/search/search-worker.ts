/**
 * Worker thread of `SearchPool`: answers searches against its own read-only connection to
 * the index file. Messages: `{ id, op, options }`, answers `{ id, ok, result | error }`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { IndexUnavailableError, SearchIndex, type SearchIndexOptions } from './search-index.js';
import type { WorkerReply, WorkerRequest } from './search-pool.js';

const { path, options } = workerData as { path: string; options: SearchIndexOptions };
const index = new SearchIndex(path, options);
const port = parentPort;

port?.on('message', (request: WorkerRequest) => {
  let reply: WorkerReply;
  try {
    const result =
      request.op === 'search'
        ? index.search(request.options)
        : request.op === 'reverse'
          ? index.reverse(request.options)
          : index.reloadIfChanged();
    reply = { id: request.id, ok: true, result };
  } catch (err) {
    reply = {
      id: request.id,
      ok: false,
      error: {
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof IndexUnavailableError && err.foundSchemaVersion !== undefined
          ? { foundSchemaVersion: err.foundSchemaVersion }
          : {}),
      },
    };
  }
  port.postMessage(reply);
});
