import { existsSync } from 'node:fs';
import type { Config } from '../config/index.js';
import { SCHEMA_VERSION } from '../import/index-writer.js';
import { IndexUnavailableError, SearchIndex } from '../search/search-index.js';

export interface StartupCheck {
  level: 'info' | 'warn' | 'error';
  message: string;
  /** End the process: a mounted index the image cannot read never fixes itself. */
  exit: boolean;
}

/**
 * Checks the index once when `serve` starts, so that a missing or unusable index
 * shows up in the log and not only as 503 answers.
 */
export function checkIndexAtStart(config: Config): StartupCheck {
  const { indexPath, indexMode } = config;
  const mounted = indexMode === 'mounted';
  if (!existsSync(indexPath)) {
    return mounted
      ? {
          level: 'warn',
          message:
            `INDEX_MODE=mounted, but there is no index at ${indexPath} yet. ` +
            '/api answers 503 until the file appears (checked on every request).',
          exit: false,
        }
      : { level: 'info', message: `No index at ${indexPath} yet`, exit: false };
  }

  const index = new SearchIndex(indexPath);
  try {
    index.open();
    const meta = index.meta() ?? {};
    const indexed = (meta['types'] ?? '').split(',').filter(Boolean);
    const wanted = config.indexTypes;
    const same = indexed.length === wanted.length && wanted.every((t) => indexed.includes(t));
    if (!mounted && indexed.length > 0 && !same) {
      return {
        level: 'warn',
        message:
          `Index ${indexPath} contains the types ${indexed.join(', ')}, but INDEX_TYPES asks ` +
          `for ${wanted.join(', ')}. Run \`import\` again (or wait for the next update) to apply it.`,
        exit: false,
      };
    }
    return {
      level: 'info',
      message:
        `Index ${indexPath} (schema ${String(SCHEMA_VERSION)}, ${meta['places'] ?? '?'} entries, ` +
        `source ${meta['source'] ?? 'unknown'}, imported ${meta['imported_at'] ?? 'unknown'})`,
      exit: false,
    };
  } catch (err) {
    if (!(err instanceof IndexUnavailableError)) throw err;
    const found = err.foundSchemaVersion;
    const message =
      found === undefined
        ? `Index ${indexPath} is unusable: ${err.message}`
        : `Index ${indexPath} has schema version ${String(found)}, this image expects ` +
          `${String(SCHEMA_VERSION)}. ` +
          (mounted
            ? 'Build the index with the same image version, or use the image that matches it.'
            : 'Run `import` again (or wait for the next update).');
    return { level: 'error', message, exit: mounted };
  } finally {
    index.close();
  }
}

/**
 * Settings that are fine for a trial but risky for a public deployment. `serve` logs each
 * one as a warning at startup.
 */
export function securityWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.metricsToken === null) {
    warnings.push('/metrics is open to everyone; set METRICS_TOKEN to protect it');
  }
  if (!config.rateLimitEnabled || config.rateLimit === 0) {
    warnings.push('Rate limiting is off (RATE_LIMIT_ENABLED=false or RATE_LIMIT=0)');
  }
  if (config.corsOrigins.includes('*')) {
    warnings.push('CORS_ORIGINS allows all origins; list your own origins to restrict browsers');
  }
  return warnings;
}
