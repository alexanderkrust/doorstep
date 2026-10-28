import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { needsAutoImport, startBackgroundImport } from '../../src/import/background.js';
import { INDEX_FILE } from '../../src/import/pipeline.js';

/** Startet ein kleines Node-Skript als "Import". */
const node = (script: string) => startBackgroundImport(process.execPath, ['-e', script], 'ignore');

describe('startBackgroundImport', () => {
  it('meldet "läuft" und danach Erfolg', async () => {
    const job = node('setTimeout(() => process.exit(0), 50)');
    expect(job.running).toBe(true);

    await expect(job.done).resolves.toBe(true);
    expect(job.running).toBe(false);
  });

  it('meldet einen Fehler bei Exit-Code ungleich 0', async () => {
    const job = node('process.exit(3)');
    await expect(job.done).resolves.toBe(false);
    expect(job.running).toBe(false);
  });

  it('meldet einen Fehler, wenn das Kommando nicht startet', async () => {
    const job = startBackgroundImport('/gibt/es/nicht', [], 'ignore');
    await expect(job.done).resolves.toBe(false);
    expect(job.running).toBe(false);
  });

  it('lässt sich beenden', async () => {
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

  it('ist wahr, wenn AUTO_IMPORT gesetzt ist und kein Index existiert', () => {
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir, AUTO_IMPORT: 'true' }))).toBe(true);
  });

  it('ist falsch, wenn AUTO_IMPORT aus ist', () => {
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir }))).toBe(false);
  });

  it('ist falsch, wenn schon ein Index existiert', async () => {
    await writeFile(join(dir, INDEX_FILE), '');
    expect(needsAutoImport(loadConfig({ DATA_DIR: dir, AUTO_IMPORT: 'true' }))).toBe(false);
  });
});
