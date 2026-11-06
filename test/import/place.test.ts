import { describe, expect, it } from 'vitest';
import {
  featureToPlace,
  importanceFor,
  parseGeoJsonSeqLine,
  representativePoint,
  withLocation,
  type Place,
} from '../../src/import/place.js';
import { TAG_FILTERS } from '../../src/import/osmium.js';

const point = (lon: number, lat: number) => ({ type: 'Point' as const, coordinates: [lon, lat] });

describe('featureToPlace', () => {
  it('turns a node with a house number into an address', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.78, 51.22),
      properties: {
        '@type': 'node',
        '@id': 42,
        'addr:street': 'Königsallee',
        'addr:housenumber': '60',
        'addr:postcode': '40212',
        'addr:city': 'Düsseldorf',
        'addr:country': 'DE',
      },
    });
    expect(place).toEqual({
      osmType: 'N',
      osmId: 42,
      type: 'house',
      name: null,
      nameDe: null,
      nameEn: null,
      street: 'Königsallee',
      housenumber: '60',
      postcode: '40212',
      city: 'Düsseldorf',
      district: null,
      state: null,
      country: 'DE',
      category: null,
      lat: 51.22,
      lon: 6.78,
      importance: importanceFor('house'),
    });
  });

  it('turns a named way with highway into a street at the middle of the line', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.0, 51.0],
          [6.0, 51.1],
          [6.0, 51.4],
        ],
      },
      properties: { '@type': 'way', '@id': 7, highway: 'residential', name: 'Königsallee' },
    });
    expect(place).toMatchObject({ osmType: 'W', osmId: 7, type: 'street', name: 'Königsallee' });
    expect(place?.lat).toBeCloseTo(51.2, 6);
    expect(place?.lon).toBeCloseTo(6.0, 6);
  });

  it('takes place objects with their type and sets city for cities', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.77, 51.22),
      properties: { '@type': 'node', '@id': 1, place: 'city', name: 'Düsseldorf' },
    });
    expect(place).toMatchObject({ type: 'city', name: 'Düsseldorf', city: 'Düsseldorf' });
  });

  it('uses addr:place as the street when an address has no addr:street', () => {
    const house = (props: Record<string, unknown>) =>
      featureToPlace({
        type: 'Feature',
        geometry: point(10.2, 47.4),
        properties: { '@type': 'node', '@id': 3, 'addr:housenumber': '16', ...props },
      });
    expect(house({ 'addr:place': 'Oberdorf' })).toMatchObject({ street: 'Oberdorf' });
    expect(house({ 'addr:place': 'Oberdorf', 'addr:street': 'Dorfstraße' })).toMatchObject({
      street: 'Dorfstraße',
    });
  });

  it('takes the district from addr:suburb, else from addr:hamlet', () => {
    const house = (props: Record<string, unknown>) =>
      featureToPlace({
        type: 'Feature',
        geometry: point(8.3, 54.9),
        properties: { '@type': 'node', '@id': 4, 'addr:housenumber': '1', ...props },
      });
    expect(house({ 'addr:city': 'Sylt', 'addr:suburb': 'Westerland' })).toMatchObject({
      city: 'Sylt',
      district: 'Westerland',
    });
    expect(house({ 'addr:hamlet': 'Kleinweiler' })).toMatchObject({ district: 'Kleinweiler' });
    expect(house({})).toMatchObject({ district: null });
  });

  describe('POI categories', () => {
    const poi = (tags: Record<string, string>) =>
      featureToPlace({
        type: 'Feature',
        geometry: point(6.95, 50.94),
        properties: { '@type': 'node', '@id': 9, ...tags },
      });

    it('turns named shops into POIs with a category, also with an address', () => {
      expect(poi({ shop: 'supermarket', name: 'REWE' })).toMatchObject({
        type: 'poi',
        category: 'shop=supermarket',
      });
      expect(
        poi({
          shop: 'supermarket',
          name: 'REWE',
          'addr:street': 'Venloer Straße',
          'addr:housenumber': '1',
        }),
      ).toMatchObject({ type: 'poi', category: 'shop=supermarket', street: 'Venloer Straße' });
    });

    it('recognizes stations, hotels, offices and more', () => {
      expect(poi({ railway: 'station', name: 'Köln Hbf' })).toMatchObject({
        category: 'railway=station',
      });
      expect(poi({ tourism: 'hotel', name: 'Hotel am Dom' })).toMatchObject({
        category: 'tourism=hotel',
      });
      expect(poi({ office: 'company', name: 'Firma' })).toMatchObject({
        category: 'office=company',
      });
      expect(poi({ healthcare: 'doctor', name: 'Praxis' })).toMatchObject({
        category: 'healthcare=doctor',
      });
    });

    it('ranks stations and airports above ordinary POIs', () => {
      const station = poi({ railway: 'station', name: 'Köln Hbf' });
      const kiosk = poi({ shop: 'kiosk', name: 'Kiosk' });
      expect(station?.importance).toBeGreaterThan(kiosk?.importance ?? 1);
    });

    it('keeps unnamed shops with an address as addresses', () => {
      expect(poi({ shop: 'bakery', 'addr:street': 'Weg', 'addr:housenumber': '2' })).toMatchObject({
        type: 'house',
      });
    });

    it('leaves out objects nobody searches for', () => {
      expect(
        poi({ tourism: 'information', information: 'guidepost', name: 'Wanderweg' }),
      ).toBeNull();
      expect(poi({ tourism: 'information', information: 'board', name: 'Stadtplan' })).toBeNull();
      expect(poi({ historic: 'memorial', memorial: 'stolperstein', name: 'Anna M.' })).toBeNull();
      expect(poi({ amenity: 'bench', name: 'Sitzbank' })).toBeNull();
      expect(poi({ amenity: 'waste_basket', name: 'Eimer' })).toBeNull();
      // Tourist offices and other memorials stay
      expect(
        poi({ tourism: 'information', information: 'office', name: 'Tourist-Info' }),
      ).toMatchObject({
        category: 'tourism=information',
      });
      expect(poi({ historic: 'memorial', name: 'Ehrenmal' })).toMatchObject({ type: 'poi' });
    });

    it('takes streets only from ways, not from single nodes such as bus stops', () => {
      expect(poi({ highway: 'bus_stop', name: 'Hauptstraße' })).toBeNull();
      expect(poi({ highway: 'motorway_junction', name: 'Köln-Ehrenfeld' })).toBeNull();
    });

    it('keeps a street a street when it only carries a generic POI tag such as tourism=yes', () => {
      const street = featureToPlace({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.78, 51.22],
            [6.78, 51.23],
          ],
        },
        properties: {
          '@type': 'way',
          '@id': 1092566016,
          highway: 'residential',
          name: 'Königsallee',
          tourism: 'yes',
        },
      });
      expect(street).toMatchObject({ type: 'street', category: 'highway=residential' });
    });

    it('leaves out subway, light rail and tram stops like bus stops', () => {
      expect(poi({ railway: 'station', station: 'subway', name: 'Schadowstraße' })).toBeNull();
      expect(
        poi({ railway: 'halt', station: 'light_rail', name: 'Heinrich-Heine-Allee' }),
      ).toBeNull();
      expect(
        poi({ public_transport: 'station', station: 'tram', name: 'Graf-Adolf-Platz' }),
      ).toBeNull();
      // Train and S-Bahn stations stay
      expect(poi({ railway: 'station', name: 'Düsseldorf Hauptbahnhof' })).toMatchObject({
        category: 'railway=station',
      });
      expect(poi({ railway: 'halt', station: 'train', name: 'Düsseldorf-Bilk' })).toMatchObject({
        category: 'railway=halt',
      });
      // Another POI tag still counts
      expect(
        poi({ railway: 'station', station: 'subway', amenity: 'cafe', name: 'Café U' }),
      ).toMatchObject({ category: 'amenity=cafe' });
    });

    it('takes named landmarks such as towers, lighthouses and peaks', () => {
      expect(poi({ man_made: 'tower', name: 'Fernmeldeturm' })).toMatchObject({
        type: 'poi',
        category: 'man_made=tower',
      });
      expect(poi({ man_made: 'lighthouse', name: 'Roter Sand' })).toMatchObject({
        category: 'man_made=lighthouse',
      });
      expect(poi({ natural: 'peak', name: 'Zugspitze' })).toMatchObject({
        category: 'natural=peak',
      });
    });

    it('leaves out other named man_made and natural objects', () => {
      expect(poi({ man_made: 'pipeline', name: 'Leitung Nord' })).toBeNull();
      expect(poi({ man_made: 'wastewater_plant', name: 'Klärwerk' })).toBeNull();
      expect(poi({ natural: 'tree', name: 'Dicke Eiche' })).toBeNull();
      // With an address they stay addresses
      expect(
        poi({ man_made: 'works', name: 'Werk', 'addr:street': 'Weg', 'addr:housenumber': '1' }),
      ).toMatchObject({ type: 'house' });
    });

    it('stores the category of places and streets too', () => {
      expect(poi({ place: 'village', name: 'Dorf' })).toMatchObject({ category: 'place=village' });
      expect(poi({ amenity: 'restaurant', name: 'Lokal' })).toMatchObject({
        category: 'amenity=restaurant',
      });
    });
  });

  it('takes name:de and name:en separately', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.77, 51.22),
      properties: {
        '@type': 'node',
        '@id': 1,
        place: 'city',
        name: 'Düsseldorf',
        'name:de': 'Düsseldorf',
        'name:en': 'Dusseldorf',
        'name:fr': 'Dusseldorf',
      },
    });
    expect(place).toMatchObject({ name: 'Düsseldorf', nameDe: 'Düsseldorf', nameEn: 'Dusseldorf' });
  });

  it('also includes objects with only name:de or name:en', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.77, 51.22),
      properties: { '@type': 'node', '@id': 1, place: 'suburb', 'name:en': 'Old Town' },
    });
    expect(place).toMatchObject({ type: 'suburb', name: null, nameEn: 'Old Town' });
  });

  it('does not set city for city districts', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.77, 51.22),
      properties: { '@type': 'node', '@id': 1, place: 'suburb', name: 'Stadtmitte' },
    });
    expect(place).toMatchObject({ type: 'suburb', name: 'Stadtmitte', city: null });
  });

  it('uses the centroid for building polygons with an address', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [6, 51],
              [6.2, 51],
              [6.2, 51.2],
              [6, 51.2],
              [6, 51],
            ],
          ],
        ],
      },
      properties: { '@type': 'way', '@id': 9, 'addr:street': 'A', 'addr:housenumber': '1' },
    });
    expect(place).toMatchObject({ osmType: 'W', type: 'house' });
    expect(place?.lat).toBeCloseTo(51.1, 6);
    expect(place?.lon).toBeCloseTo(6.1, 6);
  });

  it('turns named amenities into a POI', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.78, 51.22),
      properties: {
        '@type': 'node',
        '@id': 3,
        amenity: 'cafe',
        name: 'Café Kö',
        'addr:street': 'Königsallee',
        'addr:housenumber': '1',
      },
    });
    expect(place).toMatchObject({ type: 'poi', name: 'Café Kö', housenumber: '1' });
  });

  it('recognizes relations', () => {
    const place = featureToPlace({
      type: 'Feature',
      geometry: point(6.78, 51.22),
      properties: { '@type': 'relation', '@id': 5, place: 'quarter', name: 'Carlstadt' },
    });
    expect(place?.osmType).toBe('R');
  });

  it.each([
    ['unnamed street', { highway: 'service' }],
    ['amenity without a name', { amenity: 'bench' }],
    ['only addr:street', { 'addr:street': 'Königsallee' }],
    ['place without a name', { place: 'city' }],
    ['street name without highway', { name: 'Something' }],
  ])('drops %s', (_label, tags) => {
    expect(
      featureToPlace({
        type: 'Feature',
        geometry: point(6, 51),
        properties: { '@type': 'node', '@id': 1, ...tags },
      }),
    ).toBeNull();
  });

  it('drops features without a valid geometry or OSM ID', () => {
    const tags = { 'addr:housenumber': '1', 'addr:street': 'A' };
    expect(
      featureToPlace({
        type: 'Feature',
        geometry: null,
        properties: { '@type': 'node', '@id': 1, ...tags },
      }),
    ).toBeNull();
    expect(
      featureToPlace({ type: 'Feature', geometry: point(6, 51), properties: tags }),
    ).toBeNull();
  });
});

describe('importanceFor', () => {
  it('orders city before village before street before house number', () => {
    expect(importanceFor('city')).toBeGreaterThan(importanceFor('town'));
    expect(importanceFor('town')).toBeGreaterThan(importanceFor('village'));
    expect(importanceFor('village')).toBeGreaterThan(importanceFor('street'));
    expect(importanceFor('street')).toBeGreaterThan(importanceFor('house'));
  });

  it('returns a value between 0 and 1 for unknown types', () => {
    const value = importanceFor('irgendwas');
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});

describe('representativePoint', () => {
  it('takes the longest line for a MultiLineString', () => {
    const p = representativePoint({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [0, 0.1],
        ],
        [
          [1, 0],
          [1, 2],
        ],
      ],
    });
    expect(p).toEqual({ lon: 1, lat: 1 });
  });

  it('returns null for empty geometries', () => {
    expect(representativePoint({ type: 'LineString', coordinates: [] })).toBeNull();
  });
});

describe('parseGeoJsonSeqLine', () => {
  it('removes the record separator character and ignores empty lines', () => {
    expect(parseGeoJsonSeqLine('\u001e{"type":"Feature","geometry":null,"properties":{}}')).toEqual(
      { type: 'Feature', geometry: null, properties: {} },
    );
    expect(parseGeoJsonSeqLine('   ')).toBeNull();
  });
});

describe('withLocation', () => {
  const base: Place = {
    osmType: 'N',
    osmId: 1,
    type: 'house',
    name: null,
    nameDe: null,
    nameEn: null,
    street: 'Nieuwstraat',
    housenumber: '60',
    postcode: null,
    city: 'Kerkrade',
    district: null,
    state: 'Nordrhein-Westfalen',
    country: 'DE',
    category: null,
    lat: 50.85,
    lon: 6.07,
    importance: 0.3,
  };

  it('boundaries take precedence over addr:country and addr:state', () => {
    expect(withLocation(base, { country: 'DE', state: 'Bayern' })).toMatchObject({
      country: 'DE',
      state: 'Bayern',
    });
  });

  it('a different country per boundary also drops addr:state', () => {
    expect(withLocation(base, { country: 'NL', state: null })).toMatchObject({
      country: 'NL',
      state: null,
    });
  });

  it('the same country without a state area keeps addr:state', () => {
    expect(withLocation(base, { country: 'DE', state: null })).toMatchObject({
      country: 'DE',
      state: 'Nordrhein-Westfalen',
    });
  });

  it('without a result the tags stay', () => {
    expect(withLocation(base, { country: null, state: null })).toBe(base);
  });

  const located = { country: 'DE', state: 'Nordrhein-Westfalen' };

  it('fills a missing city, district and postcode from the boundaries', () => {
    const poi = { ...base, type: 'poi', name: 'Kiosk', city: null, postcode: null };
    expect(
      withLocation(poi, { ...located, city: 'Köln', district: 'Ehrenfeld', postcode: '50823' }),
    ).toMatchObject({ city: 'Köln', district: 'Ehrenfeld', postcode: '50823' });
  });

  it('keeps addr:city, addr:suburb and addr:postcode', () => {
    const house = { ...base, city: 'Köln', district: 'Neuehrenfeld', postcode: '50825' };
    expect(
      withLocation(house, {
        ...located,
        city: 'Cologne',
        district: 'Ehrenfeld',
        postcode: '50823',
      }),
    ).toMatchObject({ city: 'Köln', district: 'Neuehrenfeld', postcode: '50825' });
  });

  it('gives a village the municipality it belongs to as its city', () => {
    const village = { ...base, type: 'village', name: 'Kleindorf', city: 'Kleindorf' };
    expect(withLocation(village, { ...located, city: 'Großgemeinde' })).toMatchObject({
      city: 'Großgemeinde',
    });
  });
});

describe('popularity', () => {
  const feature = (tags: Record<string, string>, type = 'node') => ({
    type: 'Feature' as const,
    geometry:
      type === 'way'
        ? {
            type: 'LineString' as const,
            coordinates: [
              [6.78, 51.22],
              [6.78, 51.23],
            ],
          }
        : point(6.78, 51.22),
    properties: { '@type': type, '@id': 7, ...tags },
  });
  const importance = (tags: Record<string, string>, type = 'node') =>
    featureToPlace(feature(tags, type))?.importance ?? Number.NaN;

  it('ranks a street with a Wikidata or Wikipedia entry above an ordinary one', () => {
    const plain = importance({ highway: 'residential', name: 'Königsallee' }, 'way');
    const known = { highway: 'residential', name: 'Königsallee', wikidata: 'Q694675' };
    expect(importance(known, 'way')).toBeGreaterThan(plain);
    const viaWikipedia = { highway: 'residential', name: 'Kö', wikipedia: 'de:Königsallee' };
    expect(importance(viaWikipedia, 'way')).toBe(importance(known, 'way'));
  });

  it('does not add up Wikidata and Wikipedia', () => {
    const one = importance({ tourism: 'viewpoint', name: 'Rheinturm', wikidata: 'Q679491' });
    const both = importance({
      tourism: 'viewpoint',
      name: 'Rheinturm',
      wikidata: 'Q679491',
      wikipedia: 'en:Rheinturm',
    });
    expect(both).toBe(one);
    expect(one).toBeGreaterThan(importance({ tourism: 'viewpoint', name: 'Aussicht' }));
  });

  it('ignores tags that only describe the name, such as name:etymology:wikidata', () => {
    const tags = { highway: 'residential', name: 'Weg' };
    expect(importance({ ...tags, 'name:etymology:wikidata': 'Q57180' }, 'way')).toBe(
      importance(tags, 'way'),
    );
  });

  it('gives addresses no bonus, so that they stay behind everything else', () => {
    const house = { 'addr:street': 'Königsallee', 'addr:housenumber': '1', wikidata: 'Q1' };
    expect(importance(house)).toBe(importanceFor('house'));
  });

  it('ranks a larger city above a smaller one, but never above 1', () => {
    const city = (population: string) =>
      importance({ place: 'city', name: 'Stadt', population, wikidata: 'Q1' });
    expect(city('653253')).toBeGreaterThan(city('110000'));
    expect(city('110000')).toBeGreaterThan(importance({ place: 'city', name: 'Stadt' }));
    expect(city('3700000')).toBeLessThanOrEqual(1);
  });

  it('reads populations with thousands separators', () => {
    const town = (population: string) => importance({ place: 'town', name: 'Ort', population });
    expect(town('619 294')).toBe(town('619294'));
    expect(town('1.234')).toBe(town('1234'));
    expect(town('12,500')).toBe(town('12500'));
  });

  it('ignores invalid and very small populations', () => {
    const base = importance({ place: 'village', name: 'Dorf' });
    for (const population of ['ca. 300', 'https://example.org/x.csv', '-5', '', '800']) {
      expect(importance({ place: 'village', name: 'Dorf', population })).toBe(base);
    }
  });

  it('uses the population only for places', () => {
    const tags = { amenity: 'university', name: 'Uni' };
    expect(importance({ ...tags, population: '40000' })).toBe(importance(tags));
  });
});

describe('TAG_FILTERS', () => {
  it('also passes landmarks to the import', () => {
    expect(TAG_FILTERS).toContain(
      'nwr/man_made=tower,lighthouse,windmill,watermill,water_tower,observatory,obelisk,bridge,pier,gasometer',
    );
    expect(TAG_FILTERS).toContain('nwr/natural=peak,cave_entrance');
  });
});
