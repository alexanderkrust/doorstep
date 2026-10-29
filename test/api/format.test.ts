/**
 * Response format of a hit: id, type, category, ready-to-display texts (label, main_text,
 * secondary_text), a structured address and the distance to the request's location.
 */
import { describe, expect, it } from 'vitest';
import { toFeature } from '../../src/api/geojson.js';
import type { PlaceRow } from '../../src/search/search-index.js';

function row(overrides: Partial<PlaceRow>): PlaceRow {
  return {
    osm_type: 'N',
    osm_id: 1,
    type: 'house',
    name: null,
    name_de: null,
    name_en: null,
    street: null,
    housenumber: null,
    postcode: null,
    city: null,
    district: null,
    state: null,
    country: null,
    category: null,
    lat: 48.1376,
    lon: 11.5752,
    ...overrides,
  };
}

const MUNICH = {
  postcode: '80331',
  city: 'München',
  district: 'Altstadt-Lehel',
  state: 'Bayern',
  country: 'DE',
};

describe('toFeature', () => {
  it('formats an address like a postal address', () => {
    const feature = toFeature(
      row({ ...MUNICH, osm_type: 'W', osm_id: 42, street: 'Marienplatz', housenumber: '8' }),
      'de',
    );
    expect(feature.geometry).toEqual({ type: 'Point', coordinates: [11.5752, 48.1376] });
    expect(feature.properties).toEqual({
      id: 'way/42',
      type: 'address',
      label: 'Marienplatz 8, 80331 München, Deutschland',
      main_text: 'Marienplatz 8',
      secondary_text: '80331 München, Deutschland',
      address: {
        street: 'Marienplatz',
        housenumber: '8',
        postcode: '80331',
        city: 'München',
        district: 'Altstadt-Lehel',
        state: 'Bayern',
        country: 'Deutschland',
        country_code: 'DE',
      },
    });
  });

  it('names the country in the requested language', () => {
    const feature = toFeature(row({ ...MUNICH, street: 'Marienplatz', housenumber: '8' }), 'en');
    expect(feature.properties.secondary_text).toBe('80331 München, Germany');
    expect(feature.properties.address).toMatchObject({ country: 'Germany', country_code: 'DE' });
  });

  it('shows a POI with its name, address and category', () => {
    const feature = toFeature(
      row({
        ...MUNICH,
        type: 'poi',
        name: 'Ratskeller',
        category: 'amenity=restaurant',
        street: 'Marienplatz',
        housenumber: '8',
      }),
      'de',
    );
    expect(feature.properties).toMatchObject({
      id: 'node/1',
      type: 'poi',
      category: 'amenity=restaurant',
      name: 'Ratskeller',
      main_text: 'Ratskeller',
      secondary_text: 'Marienplatz 8, 80331 München, Deutschland',
      label: 'Ratskeller, Marienplatz 8, 80331 München, Deutschland',
    });
  });

  it('treats a named building like a POI', () => {
    const feature = toFeature(
      row({ ...MUNICH, name: 'Altes Rathaus', street: 'Marienplatz', housenumber: '15' }),
      'de',
    );
    expect(feature.properties).toMatchObject({ type: 'poi', main_text: 'Altes Rathaus' });
  });

  it('shows a street with district and city, without the postcode', () => {
    const feature = toFeature(
      row({
        ...MUNICH,
        type: 'street',
        name: 'Sendlinger Straße',
        category: 'highway=residential',
      }),
      'de',
    );
    expect(feature.properties).toMatchObject({
      type: 'street',
      main_text: 'Sendlinger Straße',
      secondary_text: 'Altstadt-Lehel, München, Deutschland',
    });
  });

  it('shows a district with the city it belongs to', () => {
    const feature = toFeature(
      row({
        type: 'suburb',
        name: 'Ehrenfeld',
        category: 'place=suburb',
        city: 'Köln',
        district: 'Ehrenfeld',
        state: 'Nordrhein-Westfalen',
        country: 'DE',
      }),
      'de',
    );
    expect(feature.properties).toMatchObject({
      type: 'sublocality',
      label: 'Ehrenfeld, Köln, Deutschland',
      secondary_text: 'Köln, Deutschland',
    });
  });

  it('shows a city with its state, a village also with its municipality', () => {
    const city = toFeature(
      row({
        type: 'city',
        name: 'Köln',
        city: 'Köln',
        state: 'Nordrhein-Westfalen',
        country: 'DE',
      }),
      'de',
    );
    expect(city.properties).toMatchObject({
      type: 'locality',
      secondary_text: 'Nordrhein-Westfalen, Deutschland',
    });
    const village = toFeature(
      row({
        type: 'village',
        name: 'Kleindorf',
        city: 'Großgemeinde',
        state: 'Bayern',
        country: 'DE',
      }),
      'de',
    );
    expect(village.properties.secondary_text).toBe('Großgemeinde, Bayern, Deutschland');
  });

  it('does not repeat the name in the secondary text', () => {
    const feature = toFeature(
      row({
        type: 'street',
        name: 'Prenzlauer Berg',
        district: 'Prenzlauer Berg',
        city: 'Berlin',
        country: 'DE',
      }),
      'de',
    );
    expect(feature.properties.label).toBe('Prenzlauer Berg, Berlin, Deutschland');
  });

  it('leaves out missing parts instead of writing empty ones', () => {
    const feature = toFeature(row({ street: 'Feldweg', housenumber: '3' }), 'de');
    expect(feature.properties).toMatchObject({ label: 'Feldweg 3', main_text: 'Feldweg 3' });
    expect(feature.properties).not.toHaveProperty('secondary_text');
    expect(feature.properties.address).toEqual({ street: 'Feldweg', housenumber: '3' });
  });

  it('picks the name by lang', () => {
    const feature = toFeature(
      row({ type: 'city', name: 'München', name_en: 'Munich', city: 'München', country: 'DE' }),
      'en',
    );
    expect(feature.properties).toMatchObject({ name: 'Munich', main_text: 'Munich' });
  });

  it('adds the distance in meters when the request has a location', () => {
    const feature = toFeature(row({ ...MUNICH, street: 'Marienplatz', housenumber: '8' }), 'de', {
      lat: 48.1376,
      lon: 11.5852,
    });
    // 0.01° of longitude at 48° N is about 743 m
    expect(feature.properties.distance_m).toBeGreaterThan(700);
    expect(feature.properties.distance_m).toBeLessThan(780);
    expect(Number.isInteger(feature.properties.distance_m)).toBe(true);
  });
});
