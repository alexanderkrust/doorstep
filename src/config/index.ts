import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Leere Strings gelten als "nicht gesetzt", damit Defaults greifen. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const envSchema = z.object({
  REGION_URL: optional(
    z
      .url({ protocol: /^https?$/, error: 'muss eine http(s)-URL sein' })
      .default('https://download.geofabrik.de/europe/germany-latest.osm.pbf'),
  ),
  HOST: optional(z.string().default('0.0.0.0')),
  PORT: optional(z.coerce.number().int().min(1).max(65535).default(2322)),
  DATA_DIR: optional(
    z.string().refine(isAbsolute, 'muss ein absoluter Pfad sein').default('/data'),
  ),
  DEFAULT_LANG: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z]{2}$/, 'muss ein zweistelliger Sprachcode sein (z. B. de)')
      .default('de'),
  ),
  /** Anfragen pro Minute und IP; 0 = aus. */
  RATE_LIMIT: optional(z.coerce.number().int().min(0).default(60)),
  /** Kommagetrennte Liste erlaubter Origins, "*" = alle. */
  CORS_ORIGINS: optional(
    z
      .string()
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      )
      .default(['*']),
  ),
  LOG_LEVEL: optional(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
  /** `serve` startet den Import im Hintergrund, falls noch kein Index existiert. */
  AUTO_IMPORT: optional(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(
        z.enum(['true', 'false', '1', '0', 'yes', 'no'], { error: 'muss true oder false sein' }),
      )
      .transform((v) => v === 'true' || v === '1' || v === 'yes')
      .default(false),
  ),
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
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Liest und validiert die Konfiguration aus Umgebungsvariablen. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Ungültige Konfiguration:\n${details}`);
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
  };
}
