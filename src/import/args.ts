import { parseArgs } from 'node:util';
import { z } from 'zod';

export class ImportArgsError extends Error {
  override name = 'ImportArgsError';
}

export interface ImportArgs {
  regionUrl: string;
  /** Local PBF file; skips the download. */
  input?: string;
}

const regionUrl = z.url({ protocol: /^https?$/, error: '--region must be an http(s) URL' });

/** Reads `--region <url>` and `--input <file>`; the region defaults to REGION_URL. */
export function parseImportArgs(argv: string[], defaultRegionUrl: string): ImportArgs {
  try {
    return parse(argv, defaultRegionUrl);
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join(', ')
        : (err as Error).message;
    throw new ImportArgsError(`Invalid arguments for import: ${message}`);
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
