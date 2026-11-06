import { createReadStream, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { INDEX_FILE } from '../config/index.js';
import { RESULT_TYPES, type ResultType } from '../search/result-type.js';
import { DiskFullError, diskSpaceWarning, freeBytes, isDiskFull } from './disk.js';
import { downloadExtract, type DownloadProgress } from './download.js';
import { IndexWriter, SCHEMA_VERSION } from './index-writer.js';
import { acquireLock } from './lock.js';
import { readLines } from './lines.js';
import { BoundaryIndex } from './boundaries.js';
import {
  exportBoundaryGeoJsonSeq,
  exportGeoJsonSeq,
  exportRelationsOpl,
  filterBoundaries,
  filterExtract,
  type ExportOptions,
} from './osmium.js';
import { featureToPlace, lineEnds, parseGeoJsonSeqLine } from './place.js';
import {
  applyDiffs,
  downloadDiff,
  fetchState,
  MAX_DIFFS,
  planRefresh,
  readExtractRecord,
  readReplicationHeader,
  ReplicationError,
  writeExtractRecord,
  type ReplicationHeader,
} from './replication.js';
import { formatCount, Progress, Steps, type Logger } from './progress.js';

export const EXTRACT_FILE = 'extract.osm.pbf';
export { INDEX_FILE };
export const NEXT_INDEX_FILE = 'index.next.sqlite';
/** When and from where the extract was last downloaded in full (see `planRefresh`). */
export const EXTRACT_RECORD_FILE = 'extract.state.json';
const NEXT_EXTRACT_FILE = 'extract.next.osm.pbf';
const DIFF_DIR = 'diffs';
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
    if (!isDiskFull(err)) throw err;
    // Free space after removing the partial index, so the number says what is left over.
    const dir = dirname(output);
    throw new DiskFullError(dir, await freeBytes(dir).catch(() => 0), err);
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
  nodeIndex: NodeIndex = 'memory',
): Promise<BoundaryIndex> {
  const filtered = join(workDir, 'boundaries.osm.pbf');
  const exportOptions = nodeIndexOptions(workDir, nodeIndex);
  try {
    await filterBoundaries(input, filtered);
    return await BoundaryIndex.load(
      () => exportBoundaryGeoJsonSeq(filtered, exportOptions),
      exportRelationsOpl(filtered),
      parseGeoJsonSeqLine,
    );
  } finally {
    await rm(filtered, { force: true });
    if (exportOptions.nodeIndexFile) await rm(exportOptions.nodeIndexFile, { force: true });
  }
}

/** Where `osmium export` keeps the node locations (IMPORT_NODE_INDEX). */
export type NodeIndex = 'memory' | 'file';

/** File name of the node locations in the work directory with IMPORT_NODE_INDEX=file. */
const NODE_INDEX_FILE = 'node-locations.idx';

function nodeIndexOptions(workDir: string, nodeIndex: NodeIndex): ExportOptions {
  return nodeIndex === 'file' ? { nodeIndexFile: join(workDir, NODE_INDEX_FILE) } : {};
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
  /** Node locations for `osmium export` in memory (default) or on disk (IMPORT_NODE_INDEX). */
  nodeIndex?: NodeIndex;
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
  const nodeIndex = options.nodeIndex ?? 'memory';
  const exportOptions = nodeIndexOptions(workDir, nodeIndex);

  await mkdir(dirname(output), { recursive: true });
  const warning = diskSpaceWarning(
    dirname(output),
    await freeBytes(dirname(output)),
    (await stat(input)).size,
  );
  if (warning) log(warning);

  try {
    steps.start('Loading boundaries (countries, states, municipalities, districts, postcodes)');
    const boundaries = await loadBoundariesFromPbf(input, workDir, nodeIndex);
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
    steps.start(
      `Reading features (osmium export, node locations ${nodeIndex === 'file' ? 'on disk' : 'in memory'})`,
    );
    const replication = await readReplicationHeader(input).catch(() => null);
    // Delete the intermediate files as soon as osmium is done (Germany: 2.5 GB filtered
    // extract), before the index build needs the most space.
    async function* features(): AsyncGenerator<string> {
      yield* exportGeoJsonSeq(filtered, exportOptions);
      await removeExportFiles(filtered, exportOptions);
    }
    const result = await writeIndex(
      features,
      output,
      {
        source: options.source ?? input,
        // Which state of the extract the index was built from: `update` skips the rebuild
        // when nothing changed since.
        ...(replication ? { extract_sequence: String(replication.sequence) } : {}),
        ...(replication?.timestamp ? { extract_timestamp: replication.timestamp } : {}),
      },
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
    await removeExportFiles(filtered, exportOptions);
  }
}

async function removeExportFiles(filtered: string, options: ExportOptions): Promise<void> {
  await rm(filtered, { force: true });
  if (options.nodeIndexFile) await rm(options.nodeIndexFile, { force: true });
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
  /**
   * `update` skips the rebuild when the index already comes from the current extract (same
   * replication state, schema and INDEX_TYPES); `import` always builds. Default `import`.
   */
  mode?: 'import' | 'update';
  /** Apply the daily diffs instead of downloading the whole extract (DIFF_UPDATES). Default on. */
  diffUpdates?: boolean;
  /** Abort a download after this long without a response or data (DOWNLOAD_TIMEOUT_MS). */
  downloadTimeoutMs?: number;
  /** Node locations for `osmium export` in memory (default) or on disk (IMPORT_NODE_INDEX). */
  nodeIndex?: NodeIndex;
}

/** How the extract was brought up to date. */
export type ExtractRefresh =
  /** A local file was given (`--input`). */
  | { kind: 'input' }
  /** The replication has nothing new. */
  | { kind: 'unchanged'; sequence: number }
  | { kind: 'diff'; diffs: number; bytes: number; sequence: number }
  /** Whole extract; `downloaded` is false when the local one matched the MD5. */
  | { kind: 'full'; reason: string; downloaded: boolean; bytes: number };

export interface RunImportResult extends ImportResult {
  extract: ExtractRefresh;
  /** `false` if `update` found the index up to date and kept it. */
  rebuilt: boolean;
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
export async function runImport(options: RunImportOptions): Promise<RunImportResult> {
  await mkdir(options.dataDir, { recursive: true });
  const release = await acquireLock(join(options.dataDir, LOCK_FILE));
  try {
    await rm(join(options.dataDir, LEGACY_LOCK_FILE), { force: true });
    return await runLockedImport(options);
  } finally {
    await release();
  }
}

async function runLockedImport(options: RunImportOptions): Promise<RunImportResult> {
  const log = options.log ?? (() => undefined);
  let input = options.input;
  let source = input;
  const steps = new Steps(log, input ? PBF_STEPS : PBF_STEPS + 1);
  const output = options.indexPath ?? join(options.dataDir, INDEX_FILE);

  let extract: ExtractRefresh = { kind: 'input' };
  if (!input) {
    input = join(options.dataDir, EXTRACT_FILE);
    source = options.regionUrl;
    steps.start(`Updating the extract (${options.regionUrl})`);
    extract = await refreshExtract(options, input, log);
    if (options.mode === 'update') {
      const kept = await upToDateIndex(output, input, options);
      if (kept !== null) {
        log(`Index ${output} is up to date (${kept.reason}), nothing to rebuild`);
        return { features: 0, places: kept.places, skipped: 0, extract, rebuilt: false };
      }
    }
  }

  const result = await importFromPbf(input, output, {
    workDir: options.dataDir,
    log,
    steps,
    ...(source ? { source } : {}),
    indexTypes: options.indexTypes,
    ...(options.nodeIndex ? { nodeIndex: options.nodeIndex } : {}),
  });
  log(`Created index ${output} with ${formatCount(result.places)} entries`);
  return { ...result, extract, rebuilt: true };
}

/**
 * Brings `extract.osm.pbf` up to date: with the daily diffs where possible, otherwise (and on
 * any error with the diffs) by downloading the whole extract. The old extract stays until the
 * new one is complete.
 */
async function refreshExtract(
  options: RunImportOptions,
  extract: string,
  log: Logger,
): Promise<ExtractRefresh> {
  const recordPath = join(options.dataDir, EXTRACT_RECORD_FILE);
  const exists = existsSync(extract);
  const header = exists ? await readReplicationHeader(extract).catch(() => null) : null;
  const record = exists ? await readExtractRecord(recordPath) : null;
  const plan = planRefresh({
    diffUpdates: options.diffUpdates ?? true,
    regionUrl: options.regionUrl,
    record,
    header,
    now: Date.now(),
  });

  let reason = plan.kind === 'full' ? plan.reason : '';
  if (plan.kind === 'diff' && header) {
    try {
      return await applyNewDiffs(header, extract, options, log);
    } catch (err) {
      reason = `diff update failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (exists) log(`Downloading the whole extract: ${reason}`);

  let lastLog = 0;
  const download = await downloadExtract(options.regionUrl, extract, {
    ...(options.downloadTimeoutMs !== undefined ? { timeoutMs: options.downloadTimeoutMs } : {}),
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
  // With a matching MD5 the local extract equals a fresh one, so this counts as well.
  await writeExtractRecord(recordPath, {
    regionUrl: options.regionUrl,
    fullDownloadAt: new Date().toISOString(),
  });
  return { kind: 'full', reason, downloaded: !download.skipped, bytes: download.bytes };
}

/** Downloads the diffs since the extract's sequence number and applies them. */
async function applyNewDiffs(
  header: ReplicationHeader,
  extract: string,
  options: RunImportOptions,
  log: Logger,
): Promise<ExtractRefresh> {
  const { dataDir } = options;
  const fetchOptions =
    options.downloadTimeoutMs !== undefined ? { timeoutMs: options.downloadTimeoutMs } : {};
  const state = await fetchState(header.baseUrl, fetchOptions);
  if (state.sequence === header.sequence) {
    log(`Extract is up to date (replication sequence ${String(state.sequence)})`);
    return { kind: 'unchanged', sequence: state.sequence };
  }
  if (state.sequence < header.sequence) {
    throw new ReplicationError(
      `the server is at sequence ${String(state.sequence)}, the extract at ${String(header.sequence)}`,
    );
  }
  const missing = state.sequence - header.sequence;
  if (missing > MAX_DIFFS) {
    throw new ReplicationError(`${String(missing)} diffs missing, more than ${String(MAX_DIFFS)}`);
  }

  const dir = join(dataDir, DIFF_DIR);
  const next = join(dataDir, NEXT_EXTRACT_FILE);
  await rm(dir, { recursive: true, force: true });
  try {
    const files: string[] = [];
    let bytes = 0;
    for (let sequence = header.sequence + 1; sequence <= state.sequence; sequence++) {
      const file = join(dir, `${String(sequence)}.osc.gz`);
      bytes += await downloadDiff(header.baseUrl, sequence, file, fetchOptions);
      files.push(file);
    }
    log(
      `Downloaded ${String(missing)} diff${missing === 1 ? '' : 's'} ` +
        `(${(bytes / 1024 / 1024).toFixed(1)} MB), applying them with osmium`,
    );
    await applyDiffs(extract, files, next, { ...header, ...state });
    await rename(next, extract);
    return { kind: 'diff', diffs: missing, bytes, sequence: state.sequence };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(next, { force: true });
  }
}

/**
 * The index if `update` can keep it: built from this region and replication state of the
 * extract, with the current schema and INDEX_TYPES. `null` if it has to be rebuilt.
 */
async function upToDateIndex(
  output: string,
  extract: string,
  options: RunImportOptions,
): Promise<{ places: number; reason: string } | null> {
  if (!existsSync(output)) return null;
  const header = await readReplicationHeader(extract).catch(() => null);
  if (!header) return null;
  let meta: Record<string, string>;
  try {
    const db = new DatabaseSync(output, { readOnly: true });
    try {
      const rows = db.prepare('SELECT key, value FROM meta').all() as {
        key: string;
        value: string;
      }[];
      meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  const types = (options.indexTypes ?? RESULT_TYPES).join(',');
  const same =
    meta['schema_version'] === String(SCHEMA_VERSION) &&
    meta['source'] === options.regionUrl &&
    meta['extract_sequence'] === String(header.sequence) &&
    meta['types'] === types;
  return same
    ? {
        places: Number(meta['places'] ?? 0),
        reason: `replication sequence ${String(header.sequence)}`,
      }
    : null;
}
