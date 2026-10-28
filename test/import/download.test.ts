import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, downloadExtract } from '../../src/import/download.js';

const payload = randomBytes(200_000);
const md5 = createHash('md5').update(payload).digest('hex');

interface ServerOptions {
  md5?: string | null;
  supportsRange?: boolean;
}

let server: Server;
let baseUrl: string;
let dir: string;
let requests: { url: string; range: string | undefined }[];

async function startServer(options: ServerOptions = {}): Promise<void> {
  const { md5: md5Body = `${md5}  extract.osm.pbf\n`, supportsRange = true } = options;
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', range: req.headers.range });
    if (req.url === '/extract.osm.pbf.md5') {
      if (md5Body === null) {
        res.writeHead(404).end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(md5Body);
      }
      return;
    }
    if (req.url !== '/extract.osm.pbf') {
      res.writeHead(404).end();
      return;
    }
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (supportsRange && match) {
      const start = Number(match[1]);
      res.writeHead(206, {
        'content-length': String(payload.length - start),
        'content-range': `bytes ${String(start)}-${String(payload.length - 1)}/${String(payload.length)}`,
      });
      res.end(payload.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-length': String(payload.length) }).end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-dl-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

describe('downloadExtract', () => {
  it('lädt die Datei herunter, prüft die MD5 und meldet Fortschritt', async () => {
    await startServer();
    const dest = join(dir, 'extract.osm.pbf');
    const progress: number[] = [];

    const result = await downloadExtract(`${baseUrl}/extract.osm.pbf`, dest, {
      onProgress: (p) => progress.push(p.received),
    });

    expect(await readFile(dest)).toEqual(payload);
    expect(result).toEqual({
      path: dest,
      bytes: payload.length,
      md5Verified: true,
      skipped: false,
    });
    expect(progress.at(-1)).toBe(payload.length);
    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });

  it('setzt einen abgebrochenen Download per Range-Request fort', async () => {
    await startServer();
    const dest = join(dir, 'extract.osm.pbf');
    await writeFile(`${dest}.part`, payload.subarray(0, 50_000));

    await downloadExtract(`${baseUrl}/extract.osm.pbf`, dest);

    expect(await readFile(dest)).toEqual(payload);
    expect(requests.find((r) => r.url === '/extract.osm.pbf')?.range).toBe('bytes=50000-');
  });

  it('beginnt neu, wenn der Server keine Range-Requests unterstützt', async () => {
    await startServer({ supportsRange: false });
    const dest = join(dir, 'extract.osm.pbf');
    await writeFile(`${dest}.part`, Buffer.from('kaputt'));

    await downloadExtract(`${baseUrl}/extract.osm.pbf`, dest);

    expect(await readFile(dest)).toEqual(payload);
  });

  it('überspringt den Download, wenn die vorhandene Datei zur MD5 passt', async () => {
    await startServer();
    const dest = join(dir, 'extract.osm.pbf');
    await writeFile(dest, payload);

    const result = await downloadExtract(`${baseUrl}/extract.osm.pbf`, dest);

    expect(result.skipped).toBe(true);
    expect(requests.some((r) => r.url === '/extract.osm.pbf')).toBe(false);
  });

  it('funktioniert ohne .md5-Datei, ohne zu prüfen', async () => {
    await startServer({ md5: null });
    const dest = join(dir, 'extract.osm.pbf');

    const result = await downloadExtract(`${baseUrl}/extract.osm.pbf`, dest);

    expect(result.md5Verified).toBe(false);
    expect(await readFile(dest)).toEqual(payload);
  });

  it('bricht bei falscher Prüfsumme ab und verwirft die Datei', async () => {
    await startServer({ md5: `${'0'.repeat(32)}  extract.osm.pbf` });
    const dest = join(dir, 'extract.osm.pbf');

    await expect(downloadExtract(`${baseUrl}/extract.osm.pbf`, dest)).rejects.toThrow(
      DownloadError,
    );
    await expect(stat(dest)).rejects.toThrow();
    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });

  it('meldet HTTP-Fehler verständlich', async () => {
    await startServer();
    await expect(
      downloadExtract(`${baseUrl}/fehlt.osm.pbf`, join(dir, 'x.osm.pbf')),
    ).rejects.toThrow(/404/);
  });
});
