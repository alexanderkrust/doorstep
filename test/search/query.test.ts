import { describe, expect, it } from 'vitest';
import { buildFtsQuery, queryVariants, withoutHousenumbers } from '../../src/search/query.js';

describe('buildFtsQuery', () => {
  it('sucht das letzte Token als Präfix, die übrigen exakt', () => {
    expect(buildFtsQuery(['Königsallee', '60'])).toBe('"Königsallee" "60"*');
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
