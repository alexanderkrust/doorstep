import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BoundaryIndex,
  parseOplRelation,
  PolygonGrid,
  unescapeOpl,
} from '../../src/import/boundaries.js';
import { isOsmiumAvailable } from '../../src/import/osmium.js';
import {
  importFromGeoJsonSeq,
  importFromPbf,
  loadBoundaryFiles,
} from '../../src/import/pipeline.js';
import type { Position } from '../../src/import/place.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const BOUNDARY_GEOJSONSEQ = join(FIXTURES, 'grenzen.geojsonseq');
const BOUNDARY_OPL = join(FIXTURES, 'grenzen.opl');

/** Echte Adresspunkte (OSM, Stand 2026-10-27). */
const KERKRADE = { lat: 50.8517797, lon: 6.075014 }; // Nieuwstraat 60, NL
const HERZOGENRATH = { lat: 50.8520063, lon: 6.075576 }; // Neustraße 127, DE, ca. 50 m weiter
const RIEZLERN = { lat: 47.3558401, lon: 10.184858 }; // Walserstraße 77, Kleinwalsertal, AT
const OBERSTDORF = { lat: 47.4097, lon: 10.2793 };
const VAALS = { lat: 50.7708, lon: 6.0186 };
const AACHEN = { lat: 50.7753, lon: 6.0839 };
const BUESINGEN = { lat: 47.6966, lon: 8.6896 }; // deutsche Exklave in der Schweiz
const SCHAFFHAUSEN = { lat: 47.6973, lon: 8.6349 };
// Mosel: deutsche und luxemburgische Grenze verlaufen an verschiedenen Ufern (Kondominium).
const REMICH = { lat: 49.544698, lon: 6.3700205 }; // Esplanade 19, LU
const MERTERT = { lat: 49.7017366, lon: 6.48399 }; // Rue Basse 35, LU
const PERL = { lat: 49.4727, lon: 6.3917 };

/** Gerade-ungerade-Regel ohne Raster, als Referenz. */
function bruteForce(rings: Position[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [x1 = 0, y1 = 0] = ring[i - 1] ?? [];
      const [x2 = 0, y2 = 0] = ring[i] ?? [];
      if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    }
  }
  return inside;
}

/** Reproduzierbare Zufallszahlen (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareWithBruteForce(rings: Position[][], samples: number, seed: number): void {
  const grid = new PolygonGrid(rings);
  const next = random(seed);
  const w = grid.maxX - grid.minX;
  const h = grid.maxY - grid.minY;
  let mismatches = 0;
  for (let i = 0; i < samples; i++) {
    const x = grid.minX - w * 0.05 + next() * w * 1.1;
    const y = grid.minY - h * 0.05 + next() * h * 1.1;
    if (grid.contains(x, y) !== bruteForce(rings, x, y)) mismatches++;
  }
  expect(mismatches).toBe(0);
}

describe('OPL', () => {
  it('hebt die Maskierung auf', () => {
    expect(unescapeOpl('Deutschland%20%%2014%%20%Schweiz')).toBe('Deutschland — Schweiz');
  });

  it('liest Tags und Wege einer Relation', () => {
    const rel = parseOplRelation(
      'r51477 TISO3166-1=DE,admin_level=2,boundary=administrative,name=Bundesrepublik%20%Deutschland Mw1@outer,n5@admin_centre,w2@,r3@subarea',
    );
    expect(rel).toEqual({
      id: 51477,
      tags: {
        'ISO3166-1': 'DE',
        admin_level: '2',
        boundary: 'administrative',
        name: 'Bundesrepublik Deutschland',
      },
      wayIds: [1, 2],
    });
    expect(parseOplRelation('w1 Nn1,n2')).toBeNull();
  });
});

describe('PolygonGrid', () => {
  it('Quadrat mit Loch', () => {
    const rings = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
        [3, 3],
      ],
    ];
    const grid = new PolygonGrid(rings);
    expect(grid.contains(1, 1)).toBe(true);
    expect(grid.contains(5, 5)).toBe(false);
    expect(grid.contains(8, 5)).toBe(true);
    expect(grid.contains(11, 5)).toBe(false);
    compareWithBruteForce(rings, 20_000, 1);
  });

  it('stimmt bei einem zackigen Stern mit der einfachen Zählung überein', () => {
    const star: Position[] = [];
    const next = random(7);
    for (let i = 0; i < 400; i++) {
      const angle = (i / 400) * 2 * Math.PI;
      const radius = 1 + next() * 4;
      star.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    star.push(star[0] ?? [0, 0]);
    compareWithBruteForce([star], 50_000, 2);
  });

  it('leere Fläche enthält nichts', () => {
    expect(new PolygonGrid([]).contains(0, 0)).toBe(false);
  });
});

describe('Grenzen aus dem Fixture', () => {
  let boundaries: BoundaryIndex;

  beforeAll(async () => {
    boundaries = await loadBoundaryFiles(BOUNDARY_GEOJSONSEQ, BOUNDARY_OPL);
  });

  it('kennt Deutschland und die angeschnittenen Bundesländer als Flächen', () => {
    const { countries, states, borderSegments } = boundaries.summary;
    // Nachbarländer sind im Extrakt unvollständig und fehlen als Fläche.
    expect(countries).toEqual(['DE']);
    expect(states).toBe(5);
    expect(borderSegments).toBeGreaterThan(0);
  });

  it('Herzogenrath liegt in Nordrhein-Westfalen', () => {
    expect(boundaries.locate(HERZOGENRATH.lat, HERZOGENRATH.lon)).toEqual({
      country: 'DE',
      state: 'Nordrhein-Westfalen',
    });
    expect(boundaries.locate(AACHEN.lat, AACHEN.lon)).toEqual({
      country: 'DE',
      state: 'Nordrhein-Westfalen',
    });
  });

  it('Kerkrade auf der anderen Straßenseite liegt in den Niederlanden', () => {
    expect(boundaries.locate(KERKRADE.lat, KERKRADE.lon)).toEqual({ country: 'NL', state: null });
    expect(boundaries.locate(VAALS.lat, VAALS.lon).country).toBe('NL');
  });

  it('Riezlern im Kleinwalsertal liegt in Österreich, Oberstdorf in Bayern', () => {
    expect(boundaries.locate(RIEZLERN.lat, RIEZLERN.lon)).toEqual({ country: 'AT', state: null });
    expect(boundaries.locate(OBERSTDORF.lat, OBERSTDORF.lon)).toEqual({
      country: 'DE',
      state: 'Bayern',
    });
  });

  it('Büsingen ist deutsch, Schaffhausen nebenan schweizerisch', () => {
    expect(boundaries.locate(BUESINGEN.lat, BUESINGEN.lon)).toEqual({
      country: 'DE',
      state: 'Baden-Württemberg',
    });
    expect(boundaries.locate(SCHAFFHAUSEN.lat, SCHAFFHAUSEN.lon).country).toBe('CH');
  });

  it('Luxemburg an der Mosel, Perl im Saarland', () => {
    expect(boundaries.locate(REMICH.lat, REMICH.lon).country).toBe('LU');
    expect(boundaries.locate(MERTERT.lat, MERTERT.lon).country).toBe('LU');
    expect(boundaries.locate(PERL.lat, PERL.lon)).toEqual({ country: 'DE', state: 'Saarland' });
  });

  it('weit weg von jeder Grenze bleibt das Land offen', () => {
    expect(boundaries.locate(40, -30)).toEqual({ country: null, state: null });
  });

  it('Punkt-in-Polygon mit Raster entspricht der einfachen Zählung', async () => {
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(BOUNDARY_GEOJSONSEQ, 'utf8')).split('\n');
    const nrw = lines.find((l) => l.includes('"Nordrhein-Westfalen"'));
    const geometry = (JSON.parse(nrw ?? '{}') as { geometry: { coordinates: Position[][][] } })
      .geometry;
    compareWithBruteForce(geometry.coordinates.flat(), 20_000, 3);
  });
});

describe('Import mit Grenzen', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doorstep-boundaries-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface Row {
    osm_id: number;
    type: string;
    city: string | null;
    state: string | null;
    country: string | null;
  }

  function rows(path: string): Map<number, Row> {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const all = db
        .prepare('SELECT osm_id, type, city, state, country FROM places')
        .all() as unknown as Row[];
      return new Map(all.map((r) => [r.osm_id, r]));
    } finally {
      db.close();
    }
  }

  function point(
    id: number,
    { lat, lon }: { lat: number; lon: number },
    tags: Record<string, string>,
  ): string {
    return JSON.stringify({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { '@type': 'node', '@id': id, ...tags },
    });
  }

  it('ersetzt addr:country und addr:state durch die Grenzen', async () => {
    const input = join(dir, 'places.geojsonseq');
    const street = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.0835, 50.7748],
          [6.0845, 50.7758],
        ],
      },
      properties: { '@type': 'way', '@id': 4, highway: 'residential', name: 'Ohne Adressen' },
    };
    await writeFile(
      input,
      [
        // falsches addr:country
        point(1, KERKRADE, {
          'addr:street': 'Nieuwstraat',
          'addr:housenumber': '60',
          'addr:city': 'Kerkrade',
          'addr:country': 'DE',
          'addr:state': 'Nordrhein-Westfalen',
        }),
        point(2, HERZOGENRATH, { 'addr:street': 'Neustraße', 'addr:housenumber': '127' }),
        point(3, RIEZLERN, {
          'addr:street': 'Walserstraße',
          'addr:housenumber': '77',
          'addr:country': 'AT',
          'addr:state': 'Vorarlberg',
        }),
        JSON.stringify(street),
        // außerhalb aller Grenzen: Tags bleiben
        point(
          5,
          { lat: 40, lon: -30 },
          {
            'addr:housenumber': '1',
            'addr:country': 'PT',
            'addr:state': 'Açores',
          },
        ),
      ].join('\n'),
    );
    const boundaries = await loadBoundaryFiles(BOUNDARY_GEOJSONSEQ, BOUNDARY_OPL);
    const output = join(dir, 'index.sqlite');
    await importFromGeoJsonSeq(input, output, { boundaries });

    const result = rows(output);
    expect(result.get(1)).toMatchObject({ country: 'NL', state: null });
    expect(result.get(2)).toMatchObject({ country: 'DE', state: 'Nordrhein-Westfalen' });
    // Land stimmt mit addr:country überein; das Bundesland aus dem Tag bleibt.
    expect(result.get(3)).toMatchObject({ country: 'AT', state: 'Vorarlberg' });
    expect(result.get(4)).toMatchObject({
      type: 'street',
      country: 'DE',
      state: 'Nordrhein-Westfalen',
    });
    expect(result.get(5)).toMatchObject({ country: 'PT', state: 'Açores' });
    expect(boundaries.stats).toEqual({ inside: 2, border: 2, unknown: 1 });

    const db = new DatabaseSync(output, { readOnly: true });
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'boundary_countries'").get() as {
      value: string;
    };
    db.close();
    expect(meta.value).toBe('DE');
  });

  it('ohne Grenzen gelten weiter die Adress-Tags', async () => {
    const input = join(dir, 'tags.geojsonseq');
    await writeFile(input, point(1, KERKRADE, { 'addr:housenumber': '60', 'addr:country': 'DE' }));
    const output = join(dir, 'tags.sqlite');
    await importFromGeoJsonSeq(input, output);
    expect(rows(output).get(1)).toMatchObject({ country: 'DE', state: null });
  });
});

/**
 * Zwei Länder als OSM-XML: DE vollständig (Quadrat 0–1), NL nur angeschnitten (Weg 2 ist
 * die gemeinsame Grenze, Weg 99 fehlt in der Datei). Bundesland HH = DE.
 */
const SYNTHETIC_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <node id="1" lat="0" lon="0" version="1"/>
  <node id="2" lat="0" lon="1" version="1"/>
  <node id="3" lat="1" lon="1" version="1"/>
  <node id="4" lat="1" lon="0" version="1"/>
  <node id="10" lat="0.5" lon="0.5" version="1">
    <tag k="addr:street" v="Innenstraße"/><tag k="addr:housenumber" v="1"/>
    <tag k="addr:country" v="NL"/>
  </node>
  <node id="11" lat="0.5" lon="-0.01" version="1">
    <tag k="addr:street" v="Buitenweg"/><tag k="addr:housenumber" v="2"/>
  </node>
  <node id="20" lat="0.2" lon="0.2" version="1"/>
  <node id="21" lat="0.2" lon="0.3" version="1"/>
  <way id="1" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/></way>
  <way id="2" version="1"><nd ref="4"/><nd ref="1"/></way>
  <way id="30" version="1">
    <nd ref="20"/><nd ref="21"/>
    <tag k="highway" v="residential"/><tag k="name" v="Leere Straße"/>
  </way>
  <relation id="100" version="1">
    <member type="way" ref="1" role="outer"/><member type="way" ref="2" role="outer"/>
    <tag k="type" v="boundary"/><tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="2"/><tag k="ISO3166-1" v="DE"/><tag k="name" v="Deutschland"/>
  </relation>
  <relation id="101" version="1">
    <member type="way" ref="1" role="outer"/><member type="way" ref="2" role="outer"/>
    <tag k="type" v="boundary"/><tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="4"/><tag k="name" v="Hamburg"/>
  </relation>
  <relation id="200" version="1">
    <member type="way" ref="2" role="outer"/><member type="way" ref="99" role="outer"/>
    <tag k="type" v="boundary"/><tag k="boundary" v="administrative"/>
    <tag k="admin_level" v="2"/><tag k="ISO3166-1" v="NL"/><tag k="name" v="Nederland"/>
  </relation>
</osm>
`;

describe.skipIf(!isOsmiumAvailable())('Import mit Grenzen aus PBF (osmium)', () => {
  it('liest Grenzen und Mitglieder über osmium', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doorstep-osm-boundaries-'));
    try {
      const input = join(dir, 'laender.osm');
      await writeFile(input, SYNTHETIC_OSM);
      const output = join(dir, 'index.sqlite');
      const logs: string[] = [];
      await importFromPbf(input, output, { log: (m) => logs.push(m) });

      const db = new DatabaseSync(output, { readOnly: true });
      const all = db
        .prepare('SELECT osm_id, type, state, country FROM places ORDER BY osm_id')
        .all();
      db.close();
      expect(all).toEqual([
        { osm_id: 10, type: 'house', state: 'Hamburg', country: 'DE' },
        { osm_id: 11, type: 'house', state: null, country: 'NL' },
        { osm_id: 30, type: 'street', state: 'Hamburg', country: 'DE' },
      ]);
      expect(logs.join('\n')).toMatch(/Länder DE, 1 Bundesländer/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
