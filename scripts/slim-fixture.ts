/**
 * Shrinks a GeoJSON sequence (output of `osmium export`) for test fixtures: only features
 * the import takes, only the tags it reads, and the representative point as geometry.
 *
 *   npx tsx scripts/slim-fixture.ts <input.geojsonseq> <output.geojsonseq>
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readLines } from '../src/import/lines.js';
import {
  featureToPlace,
  IMPORTED_TAGS,
  parseGeoJsonSeqLine,
  representativePoint,
} from '../src/import/place.js';

/** OSM type and id, `addr:*` and every other tag the import reads. */
const keep = (key: string) =>
  key === '@type' || key === '@id' || key.startsWith('addr:') || IMPORTED_TAGS.has(key);

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: tsx scripts/slim-fixture.ts <input> <output>');
  process.exit(1);
}

const out = createWriteStream(output);
let kept = 0;
for await (const line of readLines(createReadStream(input))) {
  const feature = parseGeoJsonSeqLine(line);
  if (!feature?.geometry || !feature.properties || !featureToPlace(feature)) continue;
  const point = representativePoint(feature.geometry);
  if (!point) continue;
  const properties = Object.fromEntries(
    Object.entries(feature.properties).filter(([key]) => keep(key)),
  );
  const round = (n: number) => Math.round(n * 1e7) / 1e7;
  const slim = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [round(point.lon), round(point.lat)] },
    properties,
  };
  out.write(`${JSON.stringify(slim)}\n`);
  kept++;
}
out.end();
console.log(`Wrote ${String(kept)} features`);
