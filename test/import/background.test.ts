import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { needsAutoImport, startBackgroundImport } from '../../src/import/background.js';
import { INDEX_FILE } from '../../src/import/pipeline.js';

/** Starts a small Node script as an "import". */
const node = (script: string) => startBackgroundImport(process.execPath, ['-e', script], 'ignore');

describe('startBackgroundImport', () => {
  it('reports "running" and then success', async () => {
    const job = node('setTimeout(() => process.exit(0), 50)');
    expect(job.running).toBe(true);

    await expect(job.done).resolves.toBe(true);
    expect(job.running).toBe(false);
  });

  it('reports a failure on a non-zero exit code', async () => {
    const job = node('process.exit(3)');
    await expect(job.done).resolves.toBe(false);
    expect(job.running).toBe(false);
  });

  it('reports a failure when the command does not start', async () => {
    const job = startBackgroundImport('/does/not/exist', [], 'ignore');
    await expect(job.done).resolves.toBe(false);
    expect(job.running).toBe(false);
  });

  it('can be stopped', async () => {
    const job = node('setTimeout(() => {}, 60_000)');
    job.stop();
    await expect(job.done).resolves.toBe(false);
    expect(job.running).toBe(false);
  });
});

describe('needsAutoImport', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-auto-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is true when AUTO_IMPORT is set and no index exists', () => {
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir, AUTO_IMPORT: 'true' }))).toBe(true);
  });

  it('is false when AUTO_IMPORT is off', () => {
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir }))).toBe(false);
  });

  it('is false when an index already exists', async () => {
    await writeFile(join(dir, INDEX_FILE), '');
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir, AUTO_IMPORT: 'true' }))).toBe(false);
  });

  it('looks for the index at INDEX_PATH', async () => {
    await writeFile(join(dir, INDEX_FILE), '');
    const elsewhere = join(dir, 'elsewhere', 'index.sqlite');
    const env = { DATA_DIR: dir, AUTO_IMPORT: 'true', INDEX_PATH: elsewhere };
    expect(needsAutoImport(loadConfig(env))).toBe(true);
  });

  it('is never true with a mounted index, even without a file', () => {
    const env = { DATA_DIR: dir, AUTO_IMPORT: 'true', INDEX_MODE: 'mounted' };
    expect(needsAutoImport(loadConfig(env))).toBe(false);
  });
});
