import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readLines } from './lines.js';

const OSMIUM = 'osmium';

/** Tag-Filter für `osmium tags-filter`; Straßen ohne Namen werden erst beim Import verworfen. */
export const TAG_FILTERS = [
  'nwr/addr:housenumber',
  'nwr/addr:street',
  'nwr/place',
  'w/highway',
  'nwr/amenity',
];

/**
 * Verwaltungsgrenzen für Land und Bundesland (`src/import/boundaries.ts`). Osmium nimmt die
 * Wege und Knoten der Relationen mit; `boundary=administrative` prüft erst der Import.
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
      `osmium ${args[0] ?? ''} fehlgeschlagen (Code ${String(code)}): ${stderr.trim()}`,
    );
  }
}

/** Reduziert den Extrakt auf adress-, orts- und straßenrelevante Objekte. */
export async function filterExtract(input: string, output: string): Promise<void> {
  await run(['tags-filter', input, ...TAG_FILTERS, '-o', output, '--overwrite']);
}

/** Reduziert den Extrakt auf die Verwaltungsgrenzen (Länder, Bundesländer). */
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
 * Exportiert eine PBF-Datei als GeoJSON-Sequenz und liefert sie zeilenweise,
 * ohne die Datei komplett in den Speicher zu laden.
 */
export function exportGeoJsonSeq(input: string): AsyncGenerator<string> {
  return stream(['export', input, ...GEOJSONSEQ_ARGS]);
}

/**
 * Flächen und Linien der gefilterten Grenzen als GeoJSON-Sequenz. Auch Wege ohne Tags,
 * denn manche Grenzwege tragen ihre Tags nur über die Relation.
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

/** Relationen als OPL (ohne Metadaten), zeilenweise; für die Mitglieder der Länder. */
export function exportRelationsOpl(input: string): AsyncGenerator<string> {
  return stream(['cat', input, '-t', 'relation', '-f', 'opl,add_metadata=false', '-o', '-']);
}

/** Startet osmium und liefert stdout zeilenweise; wirft bei Exit-Code ≠ 0. */
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
    // Nur bei vorzeitigem Abbruch beenden; nach dem Dateiende darf osmium sich
    // noch regulär beenden (sonst ist der Exit-Code null und der Import scheitert).
    if (!completed && child.exitCode === null) child.kill();
  }

  const [code] = await closed;
  if (code !== 0) {
    throw new OsmiumError(
      `osmium ${args[0] ?? ''} fehlgeschlagen (Code ${String(code)}): ${stderr.trim()}`,
    );
  }
}
