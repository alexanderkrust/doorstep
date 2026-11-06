import { availableParallelism } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { CronError, nextRun, parseCron } from '../import/cron.js';
import {
  parseResultTypes,
  RESULT_TYPE_LIST,
  RESULT_TYPES,
  type ResultType,
} from '../search/result-type.js';

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

/** File name of the index in DATA_DIR, unless INDEX_PATH says otherwise. */
export const INDEX_FILE = 'index.sqlite';

/**
 * `build`: the container downloads the extract and builds the index itself.
 * `mounted`: the index is built elsewhere and mounted; no download, no import.
 */
export type IndexMode = 'build' | 'mounted';

const MAX_SEARCH_WORKERS = 64;
/** One worker per core except the main thread's, at most 8; 0 on a single core. */
const autoSearchWorkers = () => Math.max(0, Math.min(8, availableParallelism() - 1));

const DEFAULT_REGION_URL = 'https://download.geofabrik.de/europe/germany-latest.osm.pbf';
const regionUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });
const absolutePath = z.string().refine(isAbsolute, 'must be an absolute path');

const envSchema = z
  .object({
    /** Validated below, only when the container builds the index. */
    REGION_URL: optional(z.string().trim().default(DEFAULT_REGION_URL)),
    HOST: optional(z.string().default('0.0.0.0')),
    PORT: optional(z.coerce.number().int().min(1).max(65535).default(2322)),
    DATA_DIR: optional(absolutePath.default('/data')),
    INDEX_MODE: optional(
      z
        .string()
        .trim()
        .toLowerCase()
        .pipe(z.enum(['build', 'mounted'], { error: 'must be build or mounted' }))
        .default('build'),
    ),
    /** Result types the import puts into the index; empty = all. */
    INDEX_TYPES: optional(
      z
        .string()
        .transform((value, ctx) => {
          const { types, unknown } = parseResultTypes(value);
          if (unknown.length > 0) {
            ctx.addIssue({
              code: 'custom',
              message: `unknown type ${unknown.join(', ')}; allowed: ${RESULT_TYPE_LIST}`,
            });
            return z.NEVER;
          }
          return types.length > 0 ? types : [...RESULT_TYPES];
        })
        .default([...RESULT_TYPES]),
    ),
    /** Path of the index file; default `$DATA_DIR/index.sqlite`. */
    INDEX_PATH: optional(absolutePath.optional()),
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
    /** `Cache-Control: max-age` of search answers in seconds; 0 = no caching by clients. */
    CACHE_MAX_AGE: optional(z.coerce.number().int().min(0).max(31_536_000).default(3600)),
    /** Bearer token that /metrics requires; without it, /metrics is open. */
    METRICS_TOKEN: optional(
      z.string().trim().min(16, 'must be at least 16 characters long').optional(),
    ),
    /**
     * Worker threads for /api and /reverse; 0 = in the main thread. `auto`: one per core
     * except the main thread's, at most 8.
     */
    SEARCH_WORKERS: optional(
      z
        .string()
        .trim()
        .toLowerCase()
        .transform((value, ctx) => {
          if (value === 'auto') return autoSearchWorkers();
          const n = /^\d+$/.test(value) ? Number(value) : NaN;
          if (!Number.isInteger(n) || n > MAX_SEARCH_WORKERS) {
            ctx.addIssue({
              code: 'custom',
              message: `must be auto or a number from 0 to ${String(MAX_SEARCH_WORKERS)}`,
            });
            return z.NEVER;
          }
          return n;
        })
        .default(autoSearchWorkers()),
    ),
    /** Schedule for automatic updates in cron format, e.g. "0 3 * * *". */
    UPDATE_CRON: optional(cronExpression.optional()),
    /** Comma-separated list of allowed origins, "*" = all. */
    CORS_ORIGINS: optional(list.default(['*'])),
    LOG_LEVEL: optional(
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
    /** `serve` starts the import in the background if no index exists yet. */
    AUTO_IMPORT: flag(false),
  })
  .superRefine((env, ctx) => {
    if (env.INDEX_MODE === 'build' && !regionUrl.safeParse(env.REGION_URL).success) {
      ctx.addIssue({ code: 'custom', path: ['REGION_URL'], message: 'must be an http(s) URL' });
    }
    if (env.INDEX_MODE === 'mounted' && env.UPDATE_CRON) {
      ctx.addIssue({
        code: 'custom',
        path: ['UPDATE_CRON'],
        message:
          'cannot be used with INDEX_MODE=mounted; replace the mounted index from outside instead',
      });
    }
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
  indexMode: IndexMode;
  /** Absolute path of the index file. */
  indexPath: string;
  /** Result types the import puts into the index (in `build` mode). */
  indexTypes: ResultType[];
  /** `max-age` for `/api` and `/reverse` in seconds; 0 = `no-store`. */
  cacheMaxAge: number;
  metricsToken: string | null;
  /** Worker threads for searches; 0 = in the main thread. */
  searchWorkers: number;
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
    indexMode: e.INDEX_MODE,
    indexPath: e.INDEX_PATH ?? join(e.DATA_DIR, INDEX_FILE),
    indexTypes: e.INDEX_TYPES,
    cacheMaxAge: e.CACHE_MAX_AGE,
    metricsToken: e.METRICS_TOKEN ?? null,
    searchWorkers: e.SEARCH_WORKERS,
  };
}
