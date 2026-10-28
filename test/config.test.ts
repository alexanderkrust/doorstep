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
    });
  });

  it('behandelt leere Strings wie nicht gesetzt', () => {
    expect(loadConfig({ PORT: '', CORS_ORIGINS: '' }).port).toBe(2322);
    expect(loadConfig({ CORS_ORIGINS: '  ' }).corsOrigins).toEqual(['*']);
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
  ])('lehnt ungültigen Wert %s=%s ab', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('nennt alle fehlerhaften Variablen in der Fehlermeldung', () => {
    expect(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'y' })).toThrow(/PORT[\s\S]*LOG_LEVEL/);
  });
});
