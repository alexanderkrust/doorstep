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

/**
 * Exportiert eine PBF-Datei als GeoJSON-Sequenz und liefert sie zeilenweise,
 * ohne die Datei komplett in den Speicher zu laden.
 */
export async function* exportGeoJsonSeq(input: string): AsyncGenerator<string> {
  const child = spawn(
    OSMIUM,
    [
      'export',
      input,
      '-f',
      'geojsonseq',
      '--attributes=type,id',
      '-x',
      'print_record_separator=false',
      '-o',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const closed = once(child, 'close') as Promise<[number | null]>;

  try {
    yield* readLines(child.stdout);
  } finally {
    if (child.exitCode === null) child.kill();
  }

  const [code] = await closed;
  if (code !== 0) {
    throw new OsmiumError(`osmium export fehlgeschlagen (Code ${String(code)}): ${stderr.trim()}`);
  }
}
