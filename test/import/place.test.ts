import { describe, expect, it } from 'vitest';
import {
  featureToPlace,
  importanceFor,
  parseGeoJsonSeqLine,
  representativePoint,
  withLocation,
  type Place,
} from '../../src/import/place.js';

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
});
