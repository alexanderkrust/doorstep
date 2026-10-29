import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readLines } from './lines.js';

const OSMIUM = 'osmium';

/** Tag filters for `osmium tags-filter`; streets without a name are dropped later, during the import. */
export const TAG_FILTERS = [
  'nwr/addr:housenumber',
  'nwr/addr:street',
  'nwr/place',
  'w/highway',
  'nwr/amenity',
];

/**
 * Administrative boundaries for country and state (`src/import/boundaries.ts`). Osmium keeps the
 * ways and nodes of the relations; the import checks `boundary=administrative` itself.
 */
export const BOUNDARY_FILTERS = ['r/admin_level=2,4'];

export class OsmiumError extends Error {
  override name = 'OsmiumError';
}

export function isOsmiumAvailable(): boolean {
  const result = spawnSync(OSMIUM, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function run(args: string[]): Promise<void> {
  const child = spawn(OSMIUM, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) {
    throw new OsmiumError(
      `osmium ${args[0] ?? ''} failed (code ${String(code)}): ${stderr.trim()}`,
    );
  }
}

/** Reduces the extract to objects relevant for addresses, places and streets. */
export async function filterExtract(input: string, output: string): Promise<void> {
  await run(['tags-filter', input, ...TAG_FILTERS, '-o', output, '--overwrite']);
}

/** Reduces the extract to the administrative boundaries (countries, states). */
export async function filterBoundaries(input: string, output: string): Promise<void> {
  await run(['tags-filter', input, ...BOUNDARY_FILTERS, '-o', output, '--overwrite']);
}

const GEOJSONSEQ_ARGS = [
  '-f',
  'geojsonseq',
  '--attributes=type,id',
  '-x',
  'print_record_separator=false',
  '-o',
  '-',
];

/**
 * Exports a PBF file as a GeoJSON sequence and yields it line by line, without
 * loading the whole file into memory.
 */
export function exportGeoJsonSeq(input: string): AsyncGenerator<string> {
  return stream(['export', input, ...GEOJSONSEQ_ARGS]);
}

/**
 * Areas and lines of the filtered boundaries as a GeoJSON sequence. Includes ways without
 * tags, because some boundary ways only carry their tags via the relation.
 */
export function exportBoundaryGeoJsonSeq(input: string): AsyncGenerator<string> {
  return stream([
    'export',
    input,
    '--geometry-types=polygon,linestring',
    '--keep-untagged',
    ...GEOJSONSEQ_ARGS,
  ]);
}

/** Relations as OPL (without metadata), line by line; for the members of the countries. */
export function exportRelationsOpl(input: string): AsyncGenerator<string> {
  return stream(['cat', input, '-t', 'relation', '-f', 'opl,add_metadata=false', '-o', '-']);
}

/** Starts osmium and yields stdout line by line; throws on exit code ≠ 0. */
async function* stream(args: string[]): AsyncGenerator<string> {
  const child = spawn(OSMIUM, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const closed = once(child, 'close') as Promise<[number | null]>;

  let completed = false;
  try {
    yield* readLines(child.stdout);
    completed = true;
  } finally {
    // Only kill on early abort; after the end of the file, osmium may still exit
    // normally (otherwise the exit code is null and the import fails).
    if (!completed && child.exitCode === null) child.kill();
  }

  const [code] = await closed;
  if (code !== 0) {
    throw new OsmiumError(
      `osmium ${args[0] ?? ''} failed (code ${String(code)}): ${stderr.trim()}`,
    );
  }
}
