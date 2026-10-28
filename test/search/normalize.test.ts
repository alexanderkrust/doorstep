import { describe, expect, it } from 'vitest';
import { indexText, normalizeTokens, normalizeWord } from '../../src/search/normalize.js';

describe('normalizeWord', () => {
  it('schreibt klein und ersetzt Umlaute und ß', () => {
    expect(normalizeWord('Königsallee')).toBe('koenigsallee');
    expect(normalizeWord('Düsseldorf')).toBe('duesseldorf');
    expect(normalizeWord('Äußere')).toBe('aeussere');
    expect(normalizeWord('STRAẞE')).toBe('strasse');
  });

  it('behandelt ae/oe/ue und ss als gleichwertig zu Umlauten', () => {
    expect(normalizeWord('Koenigsallee')).toBe(normalizeWord('Königsallee'));
    expect(normalizeWord('Strasse')).toBe(normalizeWord('Straße'));
  });

  it('entfernt andere diakritische Zeichen', () => {
    expect(normalizeWord('Café')).toBe('cafe');
    expect(normalizeWord('Łódź')).toBe('lodz');
  });

  it('normalisiert zerlegte Zeichen (NFD)', () => {
    expect(normalizeWord('Königsallee')).toBe('koenigsallee');
  });

  it('schreibt "str" am Wortende als "strasse" aus', () => {
    expect(normalizeWord('Hauptstr')).toBe('hauptstrasse');
    expect(normalizeWord('Str')).toBe('strasse');
    expect(normalizeWord('Graf-Adolf-Str')).toBe('graf-adolf-strasse');
    // Nur am Wortende: "Strand" bleibt
    expect(normalizeWord('Strand')).toBe('strand');
  });
});

describe('normalizeTokens', () => {
  it('zerlegt und normalisiert die Anfrage', () => {
    expect(normalizeTokens('Königsallee 60d')).toEqual(['koenigsallee', '60d']);
    expect(normalizeTokens('Berliner Str. 12')).toEqual(['berliner', 'strasse', '12']);
    expect(normalizeTokens('Graf-Adolf-Str.')).toEqual(['graf', 'adolf', 'strasse']);
  });

  it('fügt eine abgetrennte Hausnummer-Ergänzung an', () => {
    expect(normalizeTokens('Königsallee 60 d')).toEqual(['koenigsallee', '60d']);
    expect(normalizeTokens('Königsallee 60 D, Düsseldorf')).toEqual([
      'koenigsallee',
      '60d',
      'duesseldorf',
    ]);
    // Zwei Buchstaben sind keine Ergänzung
    expect(normalizeTokens('Ring 5 ab')).toEqual(['ring', '5', 'ab']);
  });

  it('lässt keine FTS5-Syntax durch', () => {
    expect(normalizeTokens('"foo" OR bar* NEAR(x)')).toEqual(['foo', 'or', 'bar', 'near', 'x']);
  });

  it('liefert eine leere Liste ohne Wörter', () => {
    expect(normalizeTokens(' ,;!! ')).toEqual([]);
  });
});

describe('indexText', () => {
  it('liefert normalisierte Wörter für den Volltextindex', () => {
    expect(indexText(['Graf-Adolf-Str.'])).toBe('graf adolf strasse');
  });

  it('ergänzt die Schreibweise ohne Umlaut-e (Dusseldorf → Düsseldorf)', () => {
    expect(indexText(['Düsseldorf']).split(' ').sort()).toEqual(['duesseldorf', 'dusseldorf']);
  });

  it('fasst mehrere Werte zusammen und entfernt Dubletten und null', () => {
    expect(indexText(['Düsseldorf', null, 'Dusseldorf', 'Düsseldorf']).split(' ').sort()).toEqual([
      'duesseldorf',
      'dusseldorf',
    ]);
    expect(indexText([null, undefined])).toBe('');
  });
});
