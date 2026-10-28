import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  inTextColumns,
  queryVariants,
  withinCells,
  withoutHousenumbers,
  withoutSingleLetters,
} from '../../src/search/query.js';

describe('inTextColumns', () => {
  it('beschränkt die Anfrage auf die Textspalten (nicht auf die Rasterzelle)', () => {
    expect(inTextColumns('"g5"*')).toBe('{name street housenumber postcode city} : ("g5"*)');
  });
});

describe('withinCells', () => {
  it('verlangt zusätzlich eine der Rasterzellen', () => {
    expect(withinCells('"ha"*', ['g570x773', 'g570x774'])).toBe(
      '{name street housenumber postcode city} : ("ha"*) AND cell : ("g570x773" OR "g570x774")',
    );
  });
});

describe('buildFtsQuery', () => {
  it('sucht das letzte Token als Präfix, die übrigen exakt', () => {
    expect(buildFtsQuery(['Königsallee', 'Düss'])).toBe('"Königsallee" "Düss"*');
    expect(buildFtsQuery(['Königsall'])).toBe('"Königsall"*');
  });

  it('setzt Operatoren als Literale in Anführungszeichen', () => {
    expect(buildFtsQuery(['foo', 'OR', 'bar'])).toBe('"foo" "OR" "bar"*');
  });

  it('maskiert Anführungszeichen', () => {
    expect(buildFtsQuery(['a"b'])).toBe('"a""b"*');
  });

  it('liefert null ohne Tokens', () => {
    expect(buildFtsQuery([])).toBeNull();
  });

  it('sucht eine angefangene Hausnummer nicht in der Postleitzahl', () => {
    // "4"* passte sonst auf jede Adresse mit PLZ 4xxxx.
    expect(buildFtsQuery(['koenigsallee', '4'])).toBe('"koenigsallee" - {postcode} : "4"*');
    expect(buildFtsQuery(['koenigsallee', '60d'])).toBe('"koenigsallee" - {postcode} : "60d"*');
  });

  it('lässt ab vier Ziffern auch die Postleitzahl zu', () => {
    expect(buildFtsQuery(['4021'])).toBe('"4021"*');
    expect(buildFtsQuery(['40212'])).toBe('"40212"*');
  });

  it('schränkt nur das letzte Token ein', () => {
    expect(buildFtsQuery(['4', 'koenigsallee'])).toBe('"4" "koenigsallee"*');
  });
});

describe('queryVariants', () => {
  it('kürzt bei Tippfehlern das letzte Token schrittweise', () => {
    expect(queryVariants(['Königsalleh'])).toEqual([
      '"Königsalleh"*',
      '"Königsalle"*',
      '"Königsall"*',
    ]);
  });

  it('kürzt nicht unter drei Zeichen', () => {
    expect(queryVariants(['Kö', 'abcd'])).toEqual(['"Kö" "abcd"*', '"Kö" "abc"*']);
    expect(queryVariants(['abc'])).toEqual(['"abc"*']);
  });

  it('kürzt keine Zahlen (Tippfehler-Toleranz gilt nur für Wörter)', () => {
    expect(queryVariants(['hauptstrasse', '1234'])).toEqual(['"hauptstrasse" "1234"*']);
  });

  it('liefert keine Varianten ohne Tokens', () => {
    expect(queryVariants([])).toEqual([]);
  });
});

describe('withoutHousenumbers', () => {
  it('entfernt Hausnummern', () => {
    expect(withoutHousenumbers(['koenigsallee', '999'])).toEqual(['koenigsallee']);
    expect(withoutHousenumbers(['koenigsallee', '60d', 'duesseldorf'])).toEqual([
      'koenigsallee',
      'duesseldorf',
    ]);
  });

  it('liefert null ohne Hausnummer oder wenn nichts übrig bleibt', () => {
    expect(withoutHousenumbers(['koenigsallee'])).toBeNull();
    expect(withoutHousenumbers(['12'])).toBeNull();
  });
});

describe('withoutSingleLetters', () => {
  it('lässt einzelne Buchstaben aus Abkürzungen weg ("Frankfurt a.M.")', () => {
    expect(withoutSingleLetters(['zeil', '106', 'frankfurt', 'a', 'm'])).toEqual([
      'zeil',
      '106',
      'frankfurt',
    ]);
  });

  it('behält einstellige Hausnummern', () => {
    expect(withoutSingleLetters(['hauptstrasse', '1', 'a'])).toEqual(['hauptstrasse', '1']);
  });

  it('liefert null, wenn nichts wegfällt oder nichts übrig bleibt', () => {
    expect(withoutSingleLetters(['hauptstrasse', '1'])).toBeNull();
    expect(withoutSingleLetters(['a', 'b'])).toBeNull();
  });
});
