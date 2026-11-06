import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { INDEX_FILE } from '../config/index.js';
import type { ResultType } from '../search/result-type.js';
import { downloadExtract, type DownloadProgress } from './download.js';
import { IndexWriter } from './index-writer.js';
import { acquireLock } from './lock.js';
import { readLines } from './lines.js';
import { BoundaryIndex } from './boundaries.js';
import {
  exportBoundaryGeoJsonSeq,
  exportGeoJsonSeq,
  exportRelationsOpl,
  filterBoundaries,
  filterExtract,
} from './osmium.js';
import { featureToPlace, lineEnds, parseGeoJsonSeqLine } from './place.js';
import { formatCount, Progress, Steps, type Logger } from './progress.js';

export const EXTRACT_FILE = 'extract.osm.pbf';
export { INDEX_FILE };
export const NEXT_INDEX_FILE = 'index.next.sqlite';
/** Locks `dataDir` while an import or update is running (see `acquireLock`). */
export const LOCK_FILE = 'import.lock.sqlite';
/**
 * Lock file of older versions (JSON with PID and host). It was left behind when the
 * container ended in the middle of an import and then blocked every new container.
 */
export const LEGACY_LOCK_FILE = 'import.lock';

export interface ImportResult {
  /** Number of features read. */
  features: number;
  /** Number of rows in the index. */
  places: number;
  /** Features that do not belong in the index (e.g. unnamed streets). */
  skipped: number;
}

export type { Logger } from './progress.js';

/** Object type from `osmium export`; osmium yields nodes first, then ways, then relations. */
const OSM_TYPE_NAMES: Record<string, string> = {
  node: 'nodes',
  way: 'ways',
  relation: 'relations',
};

interface WriteIndexOptions {
  boundaries?: BoundaryIndex | undefined;
  log?: Logger | undefined;
  progressIntervalMs?: number | undefined;
  /** Numbered steps; building the index starts a new one. */
  steps?: Steps | undefined;
  /** Result types that end up in the index (INDEX_TYPES); default all. */
  indexTypes?: readonly ResultType[] | undefined;
}

/** `/data/index.sqlite` → `/data/index.next.sqlite` */
function nextPath(output: string): string {
  return output.endsWith('.sqlite')
    ? `${output.slice(0, -'.sqlite'.length)}.next.sqlite`
    : `${output}.next`;
}

/**
 * Writes the features to a new file next to `output` and replaces `output` only at the
 * end, with an atomic rename. On errors, an old index stays untouched.
 */
async function writeIndex(
  openLines: () => AsyncIterable<string>,
  output: string,
  meta: Record<string, string>,
  options: WriteIndexOptions = {},
): Promise<ImportResult> {
  const { boundaries, steps } = options;
  const log = options.log ?? (() => undefined);
  const intervalMs =
    options.progressIntervalMs !== undefined ? { intervalMs: options.progressIntervalMs } : {};
  await mkdir(dirname(output), { recursive: true });
  const tmp = nextPath(output);
  await rm(tmp, { force: true });

  const writer = new IndexWriter(tmp, {
    ...(boundaries ? { locate: (lat, lon) => boundaries.locate(lat, lon) } : {}),
    ...(options.indexTypes ? { indexTypes: options.indexTypes } : {}),
    log,
    ...(options.progressIntervalMs !== undefined
      ? { progressIntervalMs: options.progressIntervalMs }
      : {}),
  });
  // The total is unknown in advance (osmium yields the features as a stream).
  const progress = new Progress(log, 'Reading features', intervalMs);
  let features = 0;
  let skipped = 0;
  try {
    // Open only here, so no data starts flowing before someone reads.
    for await (const line of openLines()) {
      const feature = parseGeoJsonSeqLine(line);
      if (!feature) continue;
      features++;
      progress.update(features, OSM_TYPE_NAMES[String(feature.properties?.['@type'])]);
      const place = featureToPlace(feature);
      if (place) writer.add(place, feature.geometry ? lineEnds(feature.geometry) : []);
      else skipped++;
    }
    progress.finish(features);
    steps?.start('Building the index (sorting, assigning streets, search index)');
    const places = writer.finish(boundaries ? { ...meta, ...boundaryMeta(boundaries) } : meta);
    await rename(tmp, output);
    return { features, places, skipped };
  } catch (err) {
    writer.abort();
    await rm(tmp, { force: true });
    throw err;
  }
}

function boundaryMeta(boundaries: BoundaryIndex): Record<string, string> {
  const { countries, states } = boundaries.summary;
  return { boundary_countries: countries.join(','), boundary_states: String(states) };
}

export interface GeoJsonSeqImportOptions {
  /** Boundaries for country and state; without them, `addr:country`/`addr:state` apply. */
  boundaries?: BoundaryIndex;
  /** Progress messages. */
  log?: Logger;
  /** Interval of the progress messages; 0 reports every step of progress (tests). */
  progressIntervalMs?: number;
  /** Result types that end up in the index (INDEX_TYPES); default all. */
  indexTypes?: readonly ResultType[] | undefined;
}

/** Imports a finished GeoJSON sequence (output of `osmium export`). */
export async function importFromGeoJsonSeq(
  input: string,
  output: string,
  options: GeoJsonSeqImportOptions = {},
): Promise<ImportResult> {
  const openLines = () => readLines(createReadStream(input));
  return writeIndex(openLines, output, { source: input }, options);
}

/**
 * Loads boundaries from finished osmium output: GeoJSON sequence (areas and lines) and
 * OPL of the relations. For tests and fixtures without osmium.
 */
export async function loadBoundaryFiles(geojsonseq: string, opl: string): Promise<BoundaryIndex> {
  return BoundaryIndex.load(
    () => readLines(createReadStream(geojsonseq)),
    readLines(createReadStream(opl)),
    parseGeoJsonSeqLine,
  );
}

/** Filters the administrative boundaries out of a PBF file and loads them. */
export async function loadBoundariesFromPbf(
  input: string,
  workDir: string,
): Promise<BoundaryIndex> {
  const filtered = join(workDir, 'boundaries.osm.pbf');
  try {
    await filterBoundaries(input, filtered);
    return await BoundaryIndex.load(
      () => exportBoundaryGeoJsonSeq(filtered),
      exportRelationsOpl(filtered),
      parseGeoJsonSeqLine,
    );
  } finally {
    await rm(filtered, { force: true });
  }
}

export interface PbfImportOptions {
  /** Directory for the filtered intermediate file (default: next to `output`). */
  workDir?: string;
  source?: string;
  log?: Logger;
  /** Step counter, if steps already ran before (download). */
  steps?: Steps;
  /** Result types that end up in the index (INDEX_TYPES); default all. */
  indexTypes?: readonly ResultType[] | undefined;
}

/** Steps of `importFromPbf`: boundaries, filtering, reading features, building the index. */
const PBF_STEPS = 4;

/** Filters a PBF file with osmium and imports it by streaming. */
export async function importFromPbf(
  input: string,
  output: string,
  options: PbfImportOptions = {},
): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  const workDir = options.workDir ?? dirname(output);
  await mkdir(workDir, { recursive: true });
  const filtered = join(workDir, 'filtered.osm.pbf');
  const steps = options.steps ?? new Steps(log, PBF_STEPS);

  try {
    steps.start('Loading boundaries (countries, states, municipalities, districts, postcodes)');
    const boundaries = await loadBoundariesFromPbf(input, workDir);
    const { countries, states, borderSegments, municipalities, districts, postcodes } =
      boundaries.summary;
    log(
      `Boundaries: countries ${countries.join(', ') || 'none'}, ${String(states)} states, ` +
        `${formatCount(municipalities)} municipalities, ${formatCount(districts)} districts, ` +
        `${formatCount(postcodes)} postcode areas, ` +
        `${formatCount(borderSegments)} segments to neighboring countries`,
    );
    steps.start(`Filtering the extract (osmium tags-filter ${input})`);
    await filterExtract(input, filtered);
    steps.start('Reading features (osmium export)');
    const result = await writeIndex(
      () => exportGeoJsonSeq(filtered),
      output,
      { source: options.source ?? input },
      { boundaries, log, steps, indexTypes: options.indexTypes },
    );
    steps.done();
    const { inside, border, unknown } = boundaries.stats;
    log(
      `Country from boundaries: ${formatCount(inside)} inside, ${formatCount(border)} via neighboring border, ` +
        `${formatCount(unknown)} without (addr:country kept)`,
    );
    return result;
  } finally {
    await rm(filtered, { force: true });
  }
}

export interface RunImportOptions {
  dataDir: string;
  /** Where the index goes; default `dataDir/index.sqlite` (INDEX_PATH). */
  indexPath?: string;
  /** Result types that end up in the index (INDEX_TYPES); default all. */
  indexTypes?: readonly ResultType[] | undefined;
  regionUrl: string;
  /** Local PBF file instead of a download. */
  input?: string;
  log?: Logger;
}

function formatProgress({ received, total }: DownloadProgress): string {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return total
    ? `${mb(received)} / ${mb(total)} MB (${((received / total) * 100).toFixed(0)} %)`
    : `${mb(received)} MB`;
}

/**
 * Complete import: download (if needed), filter, export, index under `dataDir`.
 * Throws `LockError` if an import is already running there.
 */
export async function runImport(options: RunImportOptions): Promise<ImportResult> {
  await mkdir(options.dataDir, { recursive: true });
  const release = await acquireLock(join(options.dataDir, LOCK_FILE));
  try {
    await rm(join(options.dataDir, LEGACY_LOCK_FILE), { force: true });
    return await runLockedImport(options);
  } finally {
    await release();
  }
}

async function runLockedImport(options: RunImportOptions): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  let input = options.input;
  let source = input;
  const steps = new Steps(log, input ? PBF_STEPS : PBF_STEPS + 1);

  if (!input) {
    input = join(options.dataDir, EXTRACT_FILE);
    source = options.regionUrl;
    steps.start(`Downloading the extract (${options.regionUrl})`);
    let lastLog = 0;
    const download = await downloadExtract(options.regionUrl, input, {
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastLog >= 5000) {
          lastLog = now;
          log(`Download: ${formatProgress(p)}`);
        }
      },
    });
    log(
      download.skipped
        ? 'Existing extract is up to date (MD5 matches), no download needed'
        : `Download done${download.md5Verified ? ', MD5 verified' : ' (no MD5 available)'}`,
    );
  }

  const output = options.indexPath ?? join(options.dataDir, INDEX_FILE);
  const result = await importFromPbf(input, output, {
    workDir: options.dataDir,
    log,
    steps,
    ...(source ? { source } : {}),
    indexTypes: options.indexTypes,
  });
  log(`Created index ${output} with ${formatCount(result.places)} entries`);
  return result;
}
