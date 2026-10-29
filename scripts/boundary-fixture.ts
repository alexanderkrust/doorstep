/**
 * Builds the boundary fixture (`test/fixtures/boundaries.*`) from osmium's output for the
 * administrative boundaries of an extract (see test/fixtures/README.md):
 * areas are clipped to small test regions, boundary ways to those touching a test
 * region, relations to these ways and a few tags.
 *
 *   npx tsx scripts/boundary-fixture.ts <boundaries.geojsonseq> <relations.opl> <output-without-extension>
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { parseOplRelation } from '../src/import/boundaries.js';
import { readLines } from '../src/import/lines.js';
import { parseGeoJsonSeqLine, type Position } from '../src/import/place.js';

type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

/** Test regions: Aachen/Kerkrade/Vaals, Kleinwalsertal/Oberstdorf, Büsingen, Moselle (Schengen–Wasserbillig). */
const AREAS: BBox[] = [
  [5.95, 50.75, 6.2, 50.95],
  [10.05, 47.25, 10.35, 47.45],
  [8.6, 47.65, 8.8, 47.73],
  [6.3, 49.45, 6.55, 49.75],
];
const KEEP_TAGS = new Set([
  'type',
  'boundary',
  'admin_level',
  'name',
  'ISO3166-1',
  'ISO3166-1:alpha2',
]);

const [geojsonPath, oplPath, outBase] = process.argv.slice(2);
if (!geojsonPath || !oplPath || !outBase) {
  console.error('Usage: tsx scripts/boundary-fixture.ts <geojsonseq> <opl> <output>');
  process.exit(1);
}

const round = (n: number) => Math.round(n * 1e7) / 1e7;
const inBox = ([x = 0, y = 0]: Position, [a, b, c, d]: BBox) =>
  x >= a && x <= c && y >= b && y <= d;

/** Sutherland-Hodgman at one edge of the box. */
function clipEdge(
  ring: Position[],
  inside: (p: Position) => boolean,
  cut: (a: Position, b: Position) => Position,
): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i] ?? [];
    const prev = ring[(i + ring.length - 1) % ring.length] ?? [];
    if (inside(cur)) {
      if (!inside(prev)) out.push(cut(prev, cur));
      out.push(cur);
    } else if (inside(prev)) out.push(cut(prev, cur));
  }
  return out;
}

function clipRing(ring: Position[], [minX, minY, maxX, maxY]: BBox): Position[] | null {
  const atX =
    (x: number) =>
    ([x1 = 0, y1 = 0]: Position, [x2 = 0, y2 = 0]: Position): Position => [
      x,
      y1 + ((x - x1) * (y2 - y1)) / (x2 - x1),
    ];
  const atY =
    (y: number) =>
    ([x1 = 0, y1 = 0]: Position, [x2 = 0, y2 = 0]: Position): Position => [
      x1 + ((y - y1) * (x2 - x1)) / (y2 - y1),
      y,
    ];
  let r = ring.slice(0, -1);
  r = clipEdge(r, ([x = 0]) => x >= minX, atX(minX));
  r = clipEdge(r, ([x = 0]) => x <= maxX, atX(maxX));
  r = clipEdge(r, ([, y = 0]) => y >= minY, atY(minY));
  r = clipEdge(r, ([, y = 0]) => y <= maxY, atY(maxY));
  if (r.length < 3) return null;
  const closed = [...r, r[0] ?? []];
  return closed.map(([x = 0, y = 0]) => [round(x), round(y)]);
}

const relations = [];
const memberOf = new Map<number, number[]>();
for await (const line of readLines(createReadStream(oplPath))) {
  const rel = parseOplRelation(line);
  if (!rel || rel.tags['boundary'] !== 'administrative') continue;
  if (rel.tags['admin_level'] !== '2' && rel.tags['admin_level'] !== '4') continue;
  relations.push(rel);
  for (const way of rel.wayIds) memberOf.set(way, [...(memberOf.get(way) ?? []), rel.id]);
}

const features: string[] = [];
const keptWays = new Set<number>();
const keptRelations = new Set<number>();
for await (const line of readLines(createReadStream(geojsonPath))) {
  const f = parseGeoJsonSeqLine(line);
  const props = f?.properties;
  if (!f?.geometry || !props) continue;
  const id = props['@id'] as number;
  const slimProps = Object.fromEntries(
    Object.entries(props).filter(([k]) => k.startsWith('@') || KEEP_TAGS.has(k)),
  );
  if (props['@type'] === 'way' && f.geometry.type === 'LineString') {
    if (!memberOf.has(id)) continue;
    const coords = f.geometry.coordinates;
    if (!AREAS.some((box) => coords.some((p) => inBox(p, box)))) continue;
    keptWays.add(id);
    features.push(
      JSON.stringify({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords.map(([x = 0, y = 0]) => [round(x), round(y)]),
        },
        properties: { '@type': 'way', '@id': id },
      }),
    );
    continue;
  }
  if (props['@type'] !== 'relation' || props['boundary'] !== 'administrative') continue;
  if (props['admin_level'] !== '2' && props['admin_level'] !== '4') continue;
  const polygons =
    f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates]
      : f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates
        : [];
  const clipped: Position[][][] = [];
  for (const box of AREAS) {
    for (const polygon of polygons) {
      const [outer, ...holes] = polygon;
      const o = outer ? clipRing(outer, box) : null;
      if (!o) continue;
      clipped.push([
        o,
        ...holes.map((h) => clipRing(h, box)).filter((h): h is Position[] => h !== null),
      ]);
    }
  }
  if (clipped.length === 0) continue;
  keptRelations.add(id);
  features.push(
    JSON.stringify({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: clipped },
      properties: slimProps,
    }),
  );
}

const opl: string[] = [];
const escape = (s: string) =>
  s.replace(/[\s,=@%]/g, (c) => `%${(c.codePointAt(0) ?? 0).toString(16)}%`);
for (const rel of relations) {
  const ways = rel.wayIds.filter((w) => keptWays.has(w));
  if (ways.length === 0 && !keptRelations.has(rel.id)) continue;
  const tags = Object.entries(rel.tags)
    .filter(([k]) => KEEP_TAGS.has(k))
    .map(([k, v]) => `${escape(k)}=${escape(v)}`);
  opl.push(
    `r${String(rel.id)} T${tags.join(',')} M${ways.map((w) => `w${String(w)}@outer`).join(',')}`,
  );
}

writeFileSync(`${outBase}.geojsonseq`, features.map((l) => `${l}\n`).join(''));
writeFileSync(`${outBase}.opl`, opl.map((l) => `${l}\n`).join(''));
console.log(`Wrote ${String(features.length)} features, ${String(opl.length)} relations`);
