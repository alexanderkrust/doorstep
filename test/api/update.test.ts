import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestServer,
  createFixtureIndex,
  type FeatureCollection,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const LARGE = join(ROOT, 'test', 'fixtures', 'duesseldorf.geojsonseq');
const PIPELINE = pathToFileURL(join(ROOT, 'src', 'import', 'pipeline.ts')).href;

/** Baut den Index in einem eigenen Prozess neu, wie `doorstep update` im Container. */
function updateInChildProcess(output: string): Promise<number | null> {
  const script = `
    const { importFromGeoJsonSeq } = await import(${JSON.stringify(PIPELINE)});
    await importFromGeoJsonSeq(${JSON.stringify(LARGE)}, ${JSON.stringify(output)});
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((resolve) => child.once('exit', resolve));
}

let fixture: FixtureIndex;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  fixture = await createFixtureIndex();
  app = buildTestServer(fixture.dir, {}, { reloadIntervalMs: 50 });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await fixture.cleanup();
});

const URLS = [
  '/api?q=K%C3%B6nigsallee',
  '/api?q=K%C3%B6',
  '/api?q=Benrather&lat=51.22&lon=6.78',
  '/reverse?lat=51.2235&lon=6.7795',
];

describe('Update im laufenden Betrieb', () => {
  it('tauscht den Index aus, ohne dass eine Anfrage fehlschlägt', { timeout: 60_000 }, async () => {
    const failures: string[] = [];
    let requests = 0;
    let running = true;

    // Vier Clients, die ohne Pause Anfragen schicken.
    const clients = URLS.map(async (url) => {
      while (running) {
        try {
          const res = await fetch(base + url);
          await res.arrayBuffer();
          if (res.status !== 200) failures.push(`${url}: ${String(res.status)}`);
        } catch (err) {
          failures.push(`${url}: ${String(err)}`);
        }
        requests++;
      }
    });

    const oberbilk = async () => {
      const res = await fetch(`${base}/api?q=Oberbilker%20Allee`);
      const body = (await res.json()) as FeatureCollection;
      return body.features.some((f) => f.properties['name'] === 'Oberbilker Allee');
    };

    try {
      expect(await oberbilk()).toBe(false);
      const before = requests;

      expect(await updateInChildProcess(fixture.path)).toBe(0);

      // Der Server bemerkt die neue Datei von selbst.
      const deadline = Date.now() + 5000;
      while (!(await oberbilk())) {
        if (Date.now() > deadline) throw new Error('Neuer Index wurde nicht geladen');
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(requests - before).toBeGreaterThan(20);
    } finally {
      running = false;
      await Promise.all(clients);
    }

    expect(failures).toEqual([]);
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ index: true });
  });
});
