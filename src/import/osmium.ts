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
  // POIs (`POI_TAGS` in place.ts); unnamed ones are dropped during the import.
  'nwr/amenity',
  'nwr/shop',
  'nwr/tourism',
  'nwr/railway=station,halt',
  'nwr/public_transport=station',
  'nwr/aeroway=aerodrome,terminal',
  'nwr/healthcare',
  'nwr/office',
  'nwr/leisure',
  'nwr/historic',
  'nwr/craft',
  // Landmarks (`LANDMARK_MAN_MADE`, `LANDMARK_NATURAL` in place.ts)
  'nwr/man_made=tower,lighthouse,windmill,watermill,water_tower,observatory,obelisk,bridge,pier,gasometer',
  'nwr/natural=peak,cave_entrance',
];

/**
 * Boundaries for country, state, city, district and postcode (`src/import/boundaries.ts`).
 * Osmium keeps the ways and nodes of the relations; the import checks
 * `boundary=administrative` itself. Levels 5–7 only count for cities marked `de:place=city`.
 */
export const BOUNDARY_FILTERS = ['r/admin_level=2,4,5,6,7,8,9,10', 'r/boundary=postal_code'];

export class OsmiumError extends Error {
  override name = 'OsmiumError';
}

/**
 * The error for an osmium run that did not end with code 0. Without a code, a signal ended
 * it; SIGKILL usually comes from the out-of-memory killer, often while `osmium export` keeps
 * the node locations in memory.
 */
export function osmiumFailure(
  args: readonly string[],
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): OsmiumError {
  const command = `osmium ${args[0] ?? ''}`;
  const details = stderr.trim();
  if (code === null && signal !== null) {
    const hint =
      signal === 'SIGKILL'
        ? ': this usually means it ran out of memory. Give the container more memory ' +
          '(the import needs 4–8 GB for Germany) or set IMPORT_NODE_INDEX=file to keep the ' +
          'node locations on disk'
        : '';
    return new OsmiumError(
      `${command} was killed by ${signal}${hint}${details ? ` (${details})` : ''}`,
    );
  }
  return new OsmiumError(`${command} failed (code ${String(code)}): ${details}`);
}

/**
 * Where `osmium export` keeps the node locations while it builds the geometries:
 * `memory` (osmium's default) or a file, which needs far less memory and is somewhat slower.
 */
export interface ExportOptions {
  /** Path of the index file; without it, the locations stay in memory. */
  nodeIndexFile?: string;
}

const indexArgs = (options: ExportOptions) =>
  options.nodeIndexFile ? [`--index-type=sparse_file_array,${options.nodeIndexFile}`] : [];

export function isOsmiumAvailable(): boolean {
  const result = spawnSync(OSMIUM, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

async function run(args: string[]): Promise<void> {
  const child = spawn(OSMIUM, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw osmiumFailure(args, code, signal, stderr);
}

/** Reduces the extract to objects relevant for addresses, places and streets. */
export async function filterExtract(input: string, output: string): Promise<void> {
  await run(['tags-filter', input, ...TAG_FILTERS, '-o', output, '--overwrite']);
}

/** Reduces the extract to the boundaries (administrative areas and postcodes). */
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
export function exportGeoJsonSeq(
  input: string,
  options: ExportOptions = {},
): AsyncGenerator<string> {
  return stream(['export', input, ...indexArgs(options), ...GEOJSONSEQ_ARGS]);
}

/**
 * Areas and lines of the filtered boundaries as a GeoJSON sequence. Includes ways without
 * tags, because some boundary ways only carry their tags via the relation.
 */
export function exportBoundaryGeoJsonSeq(
  input: string,
  options: ExportOptions = {},
): AsyncGenerator<string> {
  return stream([
    'export',
    input,
    ...indexArgs(options),
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
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;

  let completed = false;
  try {
    yield* readLines(child.stdout);
    completed = true;
  } finally {
    // Only kill on early abort; after the end of the file, osmium may still exit
    // normally (otherwise the exit code is null and the import fails).
    if (!completed && child.exitCode === null) child.kill();
  }

  const [code, signal] = await closed;
  if (code !== 0) throw osmiumFailure(args, code, signal, stderr);
}
