import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, downloadExtract } from '../../src/import/download.js';
import { downloadDiff, fetchState, ReplicationError } from '../../src/import/replication.js';

const TIMEOUT_MS = 200;

let server: Server;
let baseUrl: string;
let dir: string;
/** Responses the server never finishes; ended in afterEach. */
let open: ServerResponse[];

/**
 * `hang`: never answers. `stall`: sends the headers and the first bytes, then nothing.
 * Every other path: 404.
 */
async function startServer(routes: Record<string, 'hang' | 'stall'>): Promise<void> {
  open = [];
  server = createServer((req, res) => {
    const mode = routes[req.url ?? ''];
    if (mode === 'hang') {
      open.push(res);
      return;
    }
    if (mode === 'stall') {
      open.push(res);
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(100, 1));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-timeout-'));
});

afterEach(async () => {
  for (const res of open) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

describe('download timeouts', () => {
  it('aborts the extract download when the server does not answer', async () => {
    await startServer({ '/extract.osm.pbf': 'hang' });
    const started = Date.now();
    await expect(
      downloadExtract(`${baseUrl}/extract.osm.pbf`, join(dir, 'extract.osm.pbf'), {
        timeoutMs: TIMEOUT_MS,
      }),
    ).rejects.toThrow(DownloadError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('aborts a stalled download and keeps the part for resuming', async () => {
    await startServer({ '/extract.osm.pbf': 'stall' });
    const dest = join(dir, 'extract.osm.pbf');
    await expect(
      downloadExtract(`${baseUrl}/extract.osm.pbf`, dest, { timeoutMs: TIMEOUT_MS }),
    ).rejects.toThrow(/no data for 0.2 s/);
    expect((await readFile(`${dest}.part`)).length).toBe(100);
  });

  it('downloads without verifying when the .md5 does not answer in time', async () => {
    await startServer({ '/extract.osm.pbf.md5': 'hang' });
    // The extract itself is missing (404): the download got past the .md5.
    await expect(
      downloadExtract(`${baseUrl}/extract.osm.pbf`, join(dir, 'extract.osm.pbf'), {
        timeoutMs: TIMEOUT_MS,
      }),
    ).rejects.toThrow(/404/);
  });

  it('aborts fetching the replication state', async () => {
    await startServer({ '/state.txt': 'hang' });
    await expect(fetchState(baseUrl, { timeoutMs: TIMEOUT_MS })).rejects.toThrow(ReplicationError);
  });

  it('aborts a stalled diff download', async () => {
    await startServer({ '/000/000/001.osc.gz': 'stall' });
    await expect(
      downloadDiff(baseUrl, 1, join(dir, '1.osc.gz'), { timeoutMs: TIMEOUT_MS }),
    ).rejects.toThrow(/no data for 0.2 s/);
  });
});
