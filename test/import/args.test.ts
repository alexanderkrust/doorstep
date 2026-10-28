import { describe, expect, it } from 'vitest';
import { ImportArgsError, parseImportArgs } from '../../src/import/args.js';

const DEFAULT = 'https://download.geofabrik.de/europe/germany-latest.osm.pbf';

describe('parseImportArgs', () => {
  it('nutzt REGION_URL aus der Konfiguration, wenn nichts angegeben ist', () => {
    expect(parseImportArgs([], DEFAULT)).toEqual({ regionUrl: DEFAULT });
  });

  it('übernimmt --region', () => {
    const url = 'https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf';
    expect(parseImportArgs(['--region', url], DEFAULT)).toEqual({ regionUrl: url });
    expect(parseImportArgs([`--region=${url}`], DEFAULT)).toEqual({ regionUrl: url });
  });

  it('übernimmt --input für eine lokale PBF-Datei', () => {
    expect(parseImportArgs(['--input', '/tmp/x.osm.pbf'], DEFAULT)).toEqual({
      regionUrl: DEFAULT,
      input: '/tmp/x.osm.pbf',
    });
  });

  it.each([
    [['--region', 'keine-url']],
    [['--region', 'ftp://example.com/x.osm.pbf']],
    [['--unbekannt']],
    [['--region']],
  ])('lehnt %j ab', (argv) => {
    expect(() => parseImportArgs(argv, DEFAULT)).toThrow(ImportArgsError);
  });
});
