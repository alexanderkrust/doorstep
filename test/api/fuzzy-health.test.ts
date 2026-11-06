import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestServer,
  createFixtureIndex,
  type FixtureIndex,
} from '../helpers/fixture-index.js';

let fixture: FixtureIndex;

beforeAll(async () => {
  fixture = await createFixtureIndex();
});

afterAll(async () => {
  await fixture.cleanup();
});

async function fuzzyMode(): Promise<unknown> {
  const app = buildTestServer(fixture.dir);
  try {
    return (await app.inject({ method: 'GET', url: '/health' })).json<{ fuzzy?: unknown }>().fuzzy;
  } finally {
    await app.close();
  }
}

describe('/health: typo tolerance', () => {
  it('reports SymSpell for a new index and the edit variants for an older one', async () => {
    expect(await fuzzyMode()).toBe('symspell');
    const db = new DatabaseSync(fixture.path);
    db.exec("DROP TABLE fuzzy_deletes; DELETE FROM meta WHERE key = 'fuzzy';");
    db.close();
    expect(await fuzzyMode()).toBe('edits');
  });
});
