import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOsmiumAvailable } from '../../src/import/osmium.js';
import {
  importFromGeoJsonSeq,
  importFromPbf,
  INDEX_FILE,
  LEGACY_LOCK_FILE,
  runImport,
} from '../../src/import/pipeline.js';
import { ATTRIBUTION } from '../../src/api/attribution.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PBF = join(FIXTURES, 'koenigsallee.osm.pbf');
const GEOJSONSEQ = join(FIXTURES, 'koenigsallee.geojsonseq');

interface Row {
  type: string;
  name: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  lat: number;
  lon: number;
}

/** Stichproben, die in jedem erzeugten Index auffindbar sein müssen. */
function checkSamples(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const fts = (query: string) =>
      db
        .prepare(
          `SELECT p.type, p.name, p.street, p.housenumber, p.postcode, p.city, p.lat, p.lon
             FROM places_fts f JOIN places p ON p.id = f.rowid
            WHERE places_fts MATCH ? ORDER BY p.importance DESC`,
        )
        .all(query) as unknown as Row[];

    // Straße
    const streets = fts('name:Königsallee').filter((r) => r.type === 'street');
    expect(streets.length).toBeGreaterThan(0);

    // Straßen bekommen Ort und PLZ von der nächsten Adresse an derselben Straße
    for (const street of streets.filter((s) => s.name === 'Königsallee')) {
      expect(street).toMatchObject({
        city: 'Düsseldorf',
        postcode: expect.stringMatching(/^402/) as unknown,
      });
    }
    expect(fts('name:Königsallee AND city:Düsseldorf').some((r) => r.type === 'street')).toBe(true);

    // Adresse mit Hausnummer
    const house = fts('street:Königsallee AND housenumber:"60d"');
    expect(house[0]).toMatchObject({ postcode: '40212', city: 'Düsseldorf' });
    expect(house[0]?.lat).toBeCloseTo(51.222, 2);
    expect(house[0]?.lon).toBeCloseTo(6.781, 2);

    // Ort, vor Straßen und Hausnummern gerankt
    const city = fts('Düsseldorf');
    expect(city[0]).toMatchObject({ type: 'city', name: 'Düsseldorf' });

    // Präfix-Suche über den FTS5-Präfix-Index
    expect(fts('name:Königsal*').some((r) => r.name === 'Königsallee')).toBe(true);

    // Rasterzelle für die Umkreissuche: Die Kö liegt in Zelle g564x747
    expect(fts('name:Königsallee AND cell:g564x747').some((r) => r.type === 'street')).toBe(true);
    expect(fts('name:Königsallee AND cell:g1x1')).toEqual([]);

    // R*Tree: Objekte im Umkreis der Kö
    const near = db
      .prepare(
        `SELECT count(*) AS n FROM places_rtree
          WHERE min_lat >= 51.220 AND max_lat <= 51.224 AND min_lon >= 6.778 AND max_lon <= 6.783`,
      )
      .get() as { n: number };
    expect(near.n).toBeGreaterThan(10);

    // Keine doppelten OSM-Objekte (osmium exportiert geschlossene Wege teils zweifach)
    const dupes = db
      .prepare(
        'SELECT count(*) AS n FROM (SELECT 1 FROM places GROUP BY osm_type, osm_id HAVING count(*) > 1)',
      )
      .get() as { n: number };
    expect(dupes.n).toBe(0);

    // FTS und R*Tree enthalten genau die Zeilen aus places
    const counts = db
      .prepare(
        `SELECT (SELECT count(*) FROM places) AS places,
                (SELECT count(*) FROM places_fts) AS fts,
                (SELECT count(*) FROM places_rtree) AS rtree`,
      )
      .get() as { places: number; fts: number; rtree: number };
    expect(counts.places).toBeGreaterThan(500);
    expect(counts.fts).toBe(counts.places);
    expect(counts.rtree).toBe(counts.places);

    // IDs absteigend nach Wichtigkeit: FTS5 liefert Treffer in ID-Reihenfolge,
    // die Suche bekommt mit LIMIT so zuerst die wichtigsten Kandidaten.
    const unordered = db
      .prepare(
        `SELECT count(*) AS n FROM places a JOIN places b ON b.id = a.id + 1
          WHERE b.importance > a.importance`,
      )
      .get() as { n: number };
    expect(unordered.n).toBe(0);
    expect(
      (db.prepare('SELECT type FROM places ORDER BY id LIMIT 1').get() as { type: string }).type,
    ).toBe('city');

    // Metadaten inkl. Attribution
    const meta = Object.fromEntries(
      (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(
        (r) => [r.key, r.value],
      ),
    );
    expect(meta).toMatchObject({ attribution: ATTRIBUTION, places: String(counts.places) });
  } finally {
    db.close();
  }
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doorstep-import-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Import aus GeoJSON-Sequenz', () => {
  it('erzeugt einen Index, in dem Stichproben auffindbar sind', async () => {
    const out = join(dir, 'seq', 'index.sqlite');
    const result = await importFromGeoJsonSeq(GEOJSONSEQ, out);

    const lines = (await readFile(GEOJSONSEQ, 'utf8')).split('\n').filter((l) => l.trim());
    expect(result.features).toBe(lines.length);
    expect(result.places).toBeGreaterThan(500);
    expect(result.skipped).toBeGreaterThan(0);
    checkSamples(out);
    // Zwischendatei index.next.sqlite wurde per rename ersetzt
    expect(await readdir(join(dir, 'seq'))).toEqual(['index.sqlite']);
  });
});

describe.skipIf(!isOsmiumAvailable())('Import aus PBF mit osmium', () => {
  it('filtert, exportiert und importiert den Beispiel-Extrakt', async () => {
    const out = join(dir, 'pbf', 'index.sqlite');
    const result = await importFromPbf(PBF, out, { workDir: join(dir, 'pbf') });

    expect(result.places).toBeGreaterThan(500);
    checkSamples(out);
  });

  it('lässt sich von einer alten Sperrdatei aus einem anderen Container nicht aufhalten', async () => {
    // So hinterlassen ältere Versionen ihre Sperre, wenn der Container mitten im Import endet.
    const dataDir = join(dir, 'alte-sperre');
    await mkdir(dataDir, { recursive: true });
    const legacy = join(dataDir, LEGACY_LOCK_FILE);
    await writeFile(
      legacy,
      JSON.stringify({ pid: 18, host: '723eb07e300d', startedAt: new Date().toISOString() }),
    );

    const result = await runImport({
      dataDir,
      regionUrl: 'https://example.invalid/x.pbf',
      input: PBF,
    });

    expect(result.places).toBeGreaterThan(500);
    expect(existsSync(legacy)).toBe(false);
    checkSamples(join(dataDir, INDEX_FILE));
  });

  it('ersetzt einen vorhandenen Index', async () => {
    const out = join(dir, 'pbf', 'index.sqlite');
    const first = await importFromPbf(PBF, out, { workDir: join(dir, 'pbf') });
    const second = await importFromPbf(PBF, out, { workDir: join(dir, 'pbf') });
    expect(second.places).toBe(first.places);
    checkSamples(out);
  });
});
