import { describe, expect, it } from 'vitest';
import { buildFtsQuery, queryVariants, tokenize } from '../../src/search/query.js';

describe('tokenize', () => {
  it('trennt an Leerzeichen und Satzzeichen', () => {
    expect(tokenize('  Königsallee 60d ')).toEqual(['Königsallee', '60d']);
    expect(tokenize('Kö-Galerie, Düsseldorf')).toEqual(['Kö', 'Galerie', 'Düsseldorf']);
  });

  it('entfernt FTS5-Syntax', () => {
    expect(tokenize('"foo" OR bar* NEAR(x)')).toEqual(['foo', 'OR', 'bar', 'NEAR', 'x']);
  });

  it('normalisiert zerlegte Umlaute (NFD) zu NFC', () => {
    expect(tokenize('Königsallee')).toEqual(['Königsallee']);
  });

  it('liefert eine leere Liste ohne Wörter', () => {
    expect(tokenize(' ,;!! ')).toEqual([]);
  });
});

describe('buildFtsQuery', () => {
  it('sucht das letzte Token als Präfix, die übrigen exakt', () => {
    expect(buildFtsQuery(['Königsallee', '60'])).toBe('"Königsallee" "60"*');
    expect(buildFtsQuery(['Königsall'])).toBe('"Königsall"*');
  });

  it('setzt Operatoren als Literale in Anführungszeichen', () => {
    expect(buildFtsQuery(['foo', 'OR', 'bar'])).toBe('"foo" "OR" "bar"*');
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
