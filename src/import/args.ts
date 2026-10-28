import { parseArgs } from 'node:util';
import { z } from 'zod';

export class ImportArgsError extends Error {
  override name = 'ImportArgsError';
}

export interface ImportArgs {
  regionUrl: string;
  /** Lokale PBF-Datei; überspringt den Download. */
  input?: string;
}

const regionUrl = z.url({ protocol: /^https?$/, error: '--region muss eine http(s)-URL sein' });

/** Liest `--region <url>` und `--input <datei>`; Default für die Region ist REGION_URL. */
export function parseImportArgs(argv: string[], defaultRegionUrl: string): ImportArgs {
  try {
    return parse(argv, defaultRegionUrl);
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join(', ')
        : (err as Error).message;
    throw new ImportArgsError(`Ungültige Argumente für import: ${message}`);
  }
}

function parse(argv: string[], defaultRegionUrl: string): ImportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      region: { type: 'string' },
      input: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const result: ImportArgs = {
    regionUrl: regionUrl.parse(values.region ?? defaultRegionUrl),
  };
  if (values.input) result.input = values.input;
  return result;
}
