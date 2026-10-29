import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { CronError, nextRun, parseCron } from '../import/cron.js';

/** Empty strings count as "not set" so that defaults apply. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

/** `true`/`false`, `1`/`0`, `yes`/`no` (case-insensitive). */
const flag = (fallback: boolean) =>
  optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no'], { error: 'must be true or false' }))
      .transform((v) => v === 'true' || v === '1' || v === 'yes')
      .default(fallback),
  );

/** Comma-separated list without empty entries. */
const list = z.string().transform((s) =>
  s
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

/** Cron expression that parses and matches at some point. */
const cronExpression = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const schedule = parseCron(value);
      nextRun(schedule, new Date());
      return schedule.expression;
    } catch (err) {
      if (!(err instanceof CronError)) throw err;
      ctx.addIssue({ code: 'custom', message: `invalid cron expression: ${err.message}` });
      return z.NEVER;
    }
  });

const envSchema = z.object({
  REGION_URL: optional(
    z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .default('https://download.geofabrik.de/europe/germany-latest.osm.pbf'),
  ),
  HOST: optional(z.string().default('0.0.0.0')),
  PORT: optional(z.coerce.number().int().min(1).max(65535).default(2322)),
  DATA_DIR: optional(z.string().refine(isAbsolute, 'must be an absolute path').default('/data')),
  DEFAULT_LANG: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z]{2}$/, 'must be a two-letter language code (e.g. de)')
      .default('de'),
  ),
  /** Rate limiting on or off. */
  RATE_LIMIT_ENABLED: flag(true),
  /** Requests per minute and IP; 0 = off. */
  RATE_LIMIT: optional(z.coerce.number().int().min(0).default(60)),
  /** Comma-separated API keys; with a valid key, RATE_LIMIT_API_KEY applies per key. */
  API_KEYS: optional(list.default([])),
  /** Requests per minute and API key. */
  RATE_LIMIT_API_KEY: optional(z.coerce.number().int().min(1).default(600)),
  /** Take the client IP from X-Forwarded-For (only behind your own reverse proxy). */
  TRUST_PROXY: flag(false),
  /** Entries in the LRU cache for search requests; 0 = off. */
  CACHE_SIZE: optional(z.coerce.number().int().min(0).default(10_000)),
  /** Schedule for automatic updates in cron format, e.g. "0 3 * * *". */
  UPDATE_CRON: optional(cronExpression.optional()),
  /** Comma-separated list of allowed origins, "*" = all. */
  CORS_ORIGINS: optional(list.default(['*'])),
  LOG_LEVEL: optional(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  /** `serve` starts the import in the background if no index exists yet. */
  AUTO_IMPORT: flag(false),
});

export interface Config {
  regionUrl: string;
  host: string;
  port: number;
  dataDir: string;
  defaultLang: string;
  rateLimit: number;
  corsOrigins: string[];
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  autoImport: boolean;
  rateLimitEnabled: boolean;
  apiKeys: string[];
  apiKeyRateLimit: number;
  trustProxy: boolean;
  cacheSize: number;
  updateCron: string | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads and validates the configuration from environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const e = result.data;
  return {
    regionUrl: e.REGION_URL,
    host: e.HOST,
    port: e.PORT,
    dataDir: e.DATA_DIR,
    defaultLang: e.DEFAULT_LANG,
    rateLimit: e.RATE_LIMIT,
    corsOrigins: e.CORS_ORIGINS.length > 0 ? e.CORS_ORIGINS : ['*'],
    logLevel: e.LOG_LEVEL,
    autoImport: e.AUTO_IMPORT,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    apiKeys: e.API_KEYS,
    apiKeyRateLimit: e.RATE_LIMIT_API_KEY,
    trustProxy: e.TRUST_PROXY,
    cacheSize: e.CACHE_SIZE,
    updateCron: e.UPDATE_CRON ?? null,
  };
}
