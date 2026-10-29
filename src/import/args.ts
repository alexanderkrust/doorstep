import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { IndexMode } from '../config/index.js';

export class ImportArgsError extends Error {
  override name = 'ImportArgsError';
}

export interface ImportArgs {
  regionUrl: string;
  /** Local PBF file; skips the download. */
  input?: string;
  /** Import even though INDEX_MODE=mounted. */
  force?: true;
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
      force: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  const result: ImportArgs = {
    regionUrl: regionUrl.parse(values.region ?? defaultRegionUrl),
  };
  if (values.input) result.input = values.input;
  if (values.force) result.force = true;
  return result;
}

/**
 * With INDEX_MODE=mounted the index is managed outside the container: `import` and
 * `update` would overwrite it (or fail on a read-only mount). Only with `--force`.
 */
export function assertImportAllowed(
  command: 'import' | 'update',
  mode: IndexMode,
  args: Pick<ImportArgs, 'force'>,
): void {
  if (mode === 'mounted' && !args.force) {
    throw new ImportArgsError(
      `\`${command}\` is disabled with INDEX_MODE=mounted: the index is built outside the ` +
        'container. Replace the mounted file instead, or pass --force to build it here anyway.',
    );
  }
}
