import { describe, expect, it } from 'vitest';
import { ImportArgsError, parseImportArgs } from '../../src/import/args.js';

const DEFAULT = 'https://download.geofabrik.de/europe/germany-latest.osm.pbf';

describe('parseImportArgs', () => {
  it('uses REGION_URL from the configuration when nothing is given', () => {
    expect(parseImportArgs([], DEFAULT)).toEqual({ regionUrl: DEFAULT });
  });

  it('takes --region', () => {
    const url = 'https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf';
    expect(parseImportArgs(['--region', url], DEFAULT)).toEqual({ regionUrl: url });
    expect(parseImportArgs([`--region=${url}`], DEFAULT)).toEqual({ regionUrl: url });
  });

  it('takes --input for a local PBF file', () => {
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
  ])('rejects %j', (argv) => {
    expect(() => parseImportArgs(argv, DEFAULT)).toThrow(ImportArgsError);
  });
});
