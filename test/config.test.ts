import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.js';

describe('loadConfig', () => {
  it('setzt Defaults, wenn keine ENV-Variablen gesetzt sind', () => {
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
    });
  });

  it('liest und konvertiert gesetzte Werte', () => {
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
    });
  });

  it('behandelt leere Strings wie nicht gesetzt', () => {
    expect(loadConfig({ PORT: '', CORS_ORIGINS: '' }).port).toBe(2322);
    expect(loadConfig({ CORS_ORIGINS: '  ' }).corsOrigins).toEqual(['*']);
  });

  it.each([
    ['RATE_LIMIT_ENABLED', 'rateLimitEnabled'],
    ['TRUST_PROXY', 'trustProxy'],
  ] as const)('liest %s als Schalter', (key, field) => {
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
  ])('liest AUTO_IMPORT=%s als %s', (value, expected) => {
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
    ['UPDATE_CRON', 'täglich'],
    ['UPDATE_CRON', '60 3 * * *'],
    ['UPDATE_CRON', '0 3 * *'],
  ])('lehnt ungültigen Wert %s=%s ab', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('nennt alle fehlerhaften Variablen in der Fehlermeldung', () => {
    expect(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'y' })).toThrow(/PORT[\s\S]*LOG_LEVEL/);
  });
});
