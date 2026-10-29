import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkIndexAtStart } from '../../src/api/startup.js';
import { loadConfig } from '../../src/config/index.js';
import { SCHEMA_VERSION } from '../../src/import/index-writer.js';
import {
  buildTestServer,
  createFixtureIndex,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

/** A prebuilt index outside DATA_DIR, as with `-v ./index:/index:ro -e INDEX_PATH=…`. */
describe('prebuilt index (INDEX_MODE=mounted)', () => {
  let fixture: FixtureIndex;
  let dir: string;
  let indexPath: string;
  let oldIndexPath: string;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    fixture = await createFixtureIndex();
    dir = await mkdtemp(join(tmpdir(), 'doorstep-mounted-'));
    await mkdir(join(dir, 'index'));
    indexPath = join(dir, 'index', 'index.sqlite');
    await copyFile(fixture.path, indexPath);
    oldIndexPath = join(dir, 'index', 'old.sqlite');
    await copyFile(fixture.path, oldIndexPath);
    const db = new DatabaseSync(oldIndexPath);
    db.exec(`UPDATE meta SET value = '6' WHERE key = 'schema_version'`);
    db.close();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await fixture.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const env = (path: string) => ({
    DATA_DIR: join(dir, 'data'),
    INDEX_MODE: 'mounted',
    INDEX_PATH: path,
  });

  it('searches the index at INDEX_PATH', async () => {
    app = buildTestServer(join(dir, 'data'), env(indexPath));
    const res = await app.inject({ method: 'GET', url: '/api?q=K%C3%B6nigsall' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Königsallee');
  });

  it('reports mode and schema versions in /health', async () => {
    app = buildTestServer(join(dir, 'data'), env(indexPath));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({
      index: true,
      indexMode: 'mounted',
      schemaVersion: SCHEMA_VERSION,
      indexSchemaVersion: SCHEMA_VERSION,
    });
  });

  it('reports the schema version of an unusable index in /health', async () => {
    app = buildTestServer(join(dir, 'data'), env(oldIndexPath));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({
      index: false,
      schemaVersion: SCHEMA_VERSION,
      indexSchemaVersion: 6,
    });
  });

  describe('checkIndexAtStart', () => {
    it('accepts a usable index', () => {
      expect(checkIndexAtStart(loadConfig(env(indexPath)))).toMatchObject({
        level: 'info',
        exit: false,
      });
    });

    it('waits for a missing mounted index', () => {
      const result = checkIndexAtStart(loadConfig(env(join(dir, 'index', 'missing.sqlite'))));
      expect(result).toMatchObject({ level: 'warn', exit: false });
      expect(result.message).toMatch(/missing\.sqlite/);
    });

    it('stops on a mounted index with the wrong schema, naming both versions', () => {
      const result = checkIndexAtStart(loadConfig(env(oldIndexPath)));
      expect(result).toMatchObject({ level: 'error', exit: true });
      expect(result.message).toMatch(new RegExp(`schema version 6.*${String(SCHEMA_VERSION)}`));
    });

    it('keeps running with the wrong schema when the container builds the index', () => {
      const config = loadConfig({ DATA_DIR: join(dir, 'data'), INDEX_PATH: oldIndexPath });
      expect(checkIndexAtStart(config)).toMatchObject({ level: 'error', exit: false });
    });

    it('says nothing special when the container will build a missing index', () => {
      const config = loadConfig({ DATA_DIR: join(dir, 'data'), AUTO_IMPORT: 'true' });
      expect(checkIndexAtStart(config)).toMatchObject({ level: 'info', exit: false });
    });
  });
});
