import { describe, expect, it } from 'vitest';
import { availableParallelism } from 'node:os';
import { ConfigError, loadConfig } from '../src/config/index.js';

/** SEARCH_WORKERS=auto: one per core except the main thread's, at most 8. */
const AUTO_WORKERS = Math.max(0, Math.min(8, availableParallelism() - 1));

describe('loadConfig', () => {
  it('sets defaults when no env variables are set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      regionUrl: 'https://download.geofabrik.de/europe/germany-latest.osm.pbf',
      host: '0.0.0.0',
      port: 2322,
      dataDir: '/data',
      defaultLang: 'de',
      rateLimit: 60,
      corsOrigins: ['*'],
      logLevel: 'info',
      autoImport: false,
      rateLimitEnabled: true,
      apiKeys: [],
      apiKeyRateLimit: 600,
      trustProxy: false,
      cacheSize: 10_000,
      updateCron: null,
      indexMode: 'build',
      indexPath: '/data/index.sqlite',
      indexTypes: ['address', 'street', 'poi', 'locality', 'sublocality', 'place'],
      cacheMaxAge: 3600,
      metricsToken: null,
      searchWorkers: AUTO_WORKERS,
    });
  });

  it('reads and converts set values', () => {
    const config = loadConfig({
      REGION_URL: 'https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf',
      HOST: '127.0.0.1',
      PORT: '8080',
      DATA_DIR: '/tmp/doorstep',
      DEFAULT_LANG: 'EN',
      RATE_LIMIT: '0',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      LOG_LEVEL: 'debug',
      AUTO_IMPORT: 'true',
      RATE_LIMIT_ENABLED: 'false',
      API_KEYS: 'abc123, def456 ,',
      RATE_LIMIT_API_KEY: '1000',
      TRUST_PROXY: 'true',
      CACHE_SIZE: '0',
      UPDATE_CRON: ' 0 3 * * * ',
    });
    expect(config).toEqual({
      regionUrl: 'https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf',
      host: '127.0.0.1',
      port: 8080,
      dataDir: '/tmp/doorstep',
      defaultLang: 'en',
      rateLimit: 0,
      corsOrigins: ['https://a.example', 'https://b.example'],
      logLevel: 'debug',
      autoImport: true,
      rateLimitEnabled: false,
      apiKeys: ['abc123', 'def456'],
      apiKeyRateLimit: 1000,
      trustProxy: true,
      cacheSize: 0,
      updateCron: '0 3 * * *',
      indexMode: 'build',
      indexPath: '/tmp/doorstep/index.sqlite',
      indexTypes: ['address', 'street', 'poi', 'locality', 'sublocality', 'place'],
      cacheMaxAge: 3600,
      metricsToken: null,
      searchWorkers: AUTO_WORKERS,
    });
  });

  it('treats empty strings as not set', () => {
    expect(loadConfig({ PORT: '', CORS_ORIGINS: '' }).port).toBe(2322);
    expect(loadConfig({ CORS_ORIGINS: '  ' }).corsOrigins).toEqual(['*']);
  });

  it.each([
    ['RATE_LIMIT_ENABLED', 'rateLimitEnabled'],
    ['TRUST_PROXY', 'trustProxy'],
  ] as const)('reads %s as a flag', (key, field) => {
    expect(loadConfig({ [key]: 'yes' })[field]).toBe(true);
    expect(loadConfig({ [key]: '0' })[field]).toBe(false);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['NO', false],
  ])('reads AUTO_IMPORT=%s as %s', (value, expected) => {
    expect(loadConfig({ AUTO_IMPORT: value }).autoImport).toBe(expected);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '80.5'],
    ['REGION_URL', 'keine-url'],
    ['REGION_URL', 'ftp://example.com/x.osm.pbf'],
    ['DEFAULT_LANG', 'deutsch'],
    ['RATE_LIMIT', '-1'],
    ['LOG_LEVEL', 'verbose'],
    ['DATA_DIR', 'relativ/pfad'],
    ['AUTO_IMPORT', 'vielleicht'],
    ['RATE_LIMIT_ENABLED', 'an'],
    ['RATE_LIMIT_API_KEY', '0'],
    ['TRUST_PROXY', 'ja'],
    ['CACHE_SIZE', '-5'],
    ['UPDATE_CRON', 'daily'],
    ['UPDATE_CRON', '60 3 * * *'],
    ['UPDATE_CRON', '0 3 * *'],
    ['INDEX_MODE', 'readonly'],
    ['INDEX_PATH', 'index/index.sqlite'],
    ['INDEX_TYPES', 'streets'],
    ['CACHE_MAX_AGE', '-1'],
    ['CACHE_MAX_AGE', '1.5'],
    ['CACHE_MAX_AGE', 'eine Stunde'],
    ['METRICS_TOKEN', 'kurz'],
    ['SEARCH_WORKERS', '-1'],
    ['SEARCH_WORKERS', '65'],
    ['SEARCH_WORKERS', 'viele'],
    ['INDEX_TYPES', 'street,house'],
  ])('rejects the invalid value %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('names all invalid variables in the error message', () => {
    expect(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'y' })).toThrow(/PORT[\s\S]*LOG_LEVEL/);
  });

  describe('prebuilt index (INDEX_MODE=mounted)', () => {
    it('reads INDEX_MODE and INDEX_PATH', () => {
      const config = loadConfig({ INDEX_MODE: ' Mounted ', INDEX_PATH: '/index/index.sqlite' });
      expect(config.indexMode).toBe('mounted');
      expect(config.indexPath).toBe('/index/index.sqlite');
    });

    it('also takes INDEX_PATH in build mode', () => {
      expect(loadConfig({ INDEX_PATH: '/index/germany.sqlite' }).indexPath).toBe(
        '/index/germany.sqlite',
      );
    });

    it('rejects UPDATE_CRON with a hint to update from outside', () => {
      expect(() => loadConfig({ INDEX_MODE: 'mounted', UPDATE_CRON: '0 3 * * *' })).toThrow(
        /UPDATE_CRON: .*INDEX_MODE=mounted/,
      );
    });

    it('does not need a valid REGION_URL', () => {
      expect(loadConfig({ INDEX_MODE: 'mounted', REGION_URL: 'keine-url' }).indexMode).toBe(
        'mounted',
      );
    });
  });

  describe('INDEX_TYPES', () => {
    it('reads a comma-separated list of result types, case-insensitive', () => {
      expect(loadConfig({ INDEX_TYPES: ' Street, poi ,street' }).indexTypes).toEqual([
        'street',
        'poi',
      ]);
    });

    it('takes all types when empty', () => {
      expect(loadConfig({ INDEX_TYPES: ' , ' }).indexTypes).toHaveLength(6);
    });

    it('names the allowed values in the error message', () => {
      expect(() => loadConfig({ INDEX_TYPES: 'streets' })).toThrow(
        /INDEX_TYPES: .*address, street, poi, locality, sublocality, place/,
      );
    });
  });

  it('reads CACHE_MAX_AGE in seconds, 0 included', () => {
    expect(loadConfig({ CACHE_MAX_AGE: '300' }).cacheMaxAge).toBe(300);
    expect(loadConfig({ CACHE_MAX_AGE: '0' }).cacheMaxAge).toBe(0);
  });

  it('reads METRICS_TOKEN', () => {
    expect(loadConfig({ METRICS_TOKEN: ' s3cr3t-metrics-token ' }).metricsToken).toBe(
      's3cr3t-metrics-token',
    );
  });

  it('reads SEARCH_WORKERS as a number or auto', () => {
    expect(loadConfig({ SEARCH_WORKERS: '0' }).searchWorkers).toBe(0);
    expect(loadConfig({ SEARCH_WORKERS: '3' }).searchWorkers).toBe(3);
    expect(loadConfig({ SEARCH_WORKERS: ' AUTO ' }).searchWorkers).toBe(AUTO_WORKERS);
  });
});
