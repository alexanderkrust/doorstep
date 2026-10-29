import { describe, expect, it } from 'vitest';
import {
  housenumberText,
  indexText,
  nameForms,
  normalizeTokens,
  normalizeWord,
} from '../../src/search/normalize.js';

describe('normalizeWord', () => {
  it('lowercases and replaces umlauts and ß', () => {
    expect(normalizeWord('Königsallee')).toBe('koenigsallee');
    expect(normalizeWord('Düsseldorf')).toBe('duesseldorf');
    expect(normalizeWord('Äußere')).toBe('aeussere');
    expect(normalizeWord('STRAẞE')).toBe('strasse');
  });

  it('treats ae/oe/ue and ss as equivalent to umlauts', () => {
    expect(normalizeWord('Koenigsallee')).toBe(normalizeWord('Königsallee'));
    expect(normalizeWord('Strasse')).toBe(normalizeWord('Straße'));
  });

  it('removes other diacritics', () => {
    expect(normalizeWord('Café')).toBe('cafe');
    expect(normalizeWord('Łódź')).toBe('lodz');
  });

  it('normalizes decomposed characters (NFD)', () => {
    expect(normalizeWord('Königsallee')).toBe('koenigsallee');
  });

  it('expands "str" at the end of a word to "strasse"', () => {
    expect(normalizeWord('Hauptstr')).toBe('hauptstrasse');
    expect(normalizeWord('Str')).toBe('strasse');
    expect(normalizeWord('Graf-Adolf-Str')).toBe('graf-adolf-strasse');
    // Only at the end of a word: "Strand" stays
    expect(normalizeWord('Strand')).toBe('strand');
  });

  it('treats "Schlosstr" like "Schloßstraße" (three s become two)', () => {
    expect(normalizeWord('Schlosstr')).toBe(normalizeWord('Schloßstraße'));
    expect(normalizeWord('Schlossstrasse')).toBe(normalizeWord('Schloßstraße'));
    // Partial input stays a prefix of the name
    expect(normalizeWord('Schloßstraße').startsWith(normalizeWord('Schlossst'))).toBe(true);
  });
});

describe('normalizeTokens', () => {
  it('splits and normalizes the query', () => {
    expect(normalizeTokens('Königsallee 60d')).toEqual(['koenigsallee', '60d']);
    expect(normalizeTokens('Berliner Str. 12')).toEqual(['berliner', 'strasse', '12']);
    expect(normalizeTokens('Graf-Adolf-Str.')).toEqual(['graf', 'adolf', 'strasse']);
  });

  it('attaches a separate house number suffix', () => {
    expect(normalizeTokens('Königsallee 60 d')).toEqual(['koenigsallee', '60d']);
    expect(normalizeTokens('Königsallee 60 D, Düsseldorf')).toEqual([
      'koenigsallee',
      '60d',
      'duesseldorf',
    ]);
    // Two letters are not a suffix
    expect(normalizeTokens('Ring 5 ab')).toEqual(['ring', '5', 'ab']);
  });

  it('splits off a house number attached without a space', () => {
    expect(normalizeTokens('friedrichstraße43 berlin')).toEqual([
      'friedrichstrasse',
      '43',
      'berlin',
    ]);
    expect(normalizeTokens('Hauptstr12a')).toEqual(['hauptstrasse', '12a']);
    // Short names like motorways stay together
    expect(normalizeTokens('A7')).toEqual(['a7']);
  });

  it('expands "St." before another word to "Sankt"', () => {
    expect(normalizeTokens('St. Augustin')).toEqual(['sankt', 'augustin']);
    expect(normalizeTokens('Sankt Augustin')).toEqual(['sankt', 'augustin']);
    // As the last word, "st" is a partial word ("Stuttgart")
    expect(normalizeTokens('St')).toEqual(['st']);
  });

  it('lets no FTS5 syntax through', () => {
    expect(normalizeTokens('"foo" OR bar* NEAR(x)')).toEqual(['foo', 'or', 'bar', 'near', 'x']);
  });

  it('returns an empty list without words', () => {
    expect(normalizeTokens(' ,;!! ')).toEqual([]);
  });
});

describe('indexText', () => {
  it('returns normalized words for the full-text index', () => {
    expect(indexText(['Graf-Adolf-Str.'])).toBe('graf adolf strasse adolfstrasse');
  });

  it('adds the spelling without umlaut e (Dusseldorf → Düsseldorf)', () => {
    expect(indexText(['Düsseldorf']).split(' ').sort()).toEqual(['duesseldorf', 'dusseldorf']);
  });

  it('combines several values and removes duplicates and null', () => {
    expect(indexText(['Düsseldorf', null, 'Dusseldorf', 'Düsseldorf']).split(' ').sort()).toEqual([
      'duesseldorf',
      'dusseldorf',
    ]);
    expect(indexText([null, undefined])).toBe('');
  });
});

describe('indexText and nameForms', () => {
  it('indexes "St." as "Sankt"', () => {
    expect(indexText(['St. Pauli']).split(' ')).toContain('sankt');
    expect(nameForms('St. Ingbert')).toContain('sankt ingbert');
  });
});

describe('housenumberText', () => {
  it('also indexes "12 a" as "12a" so both spellings match', () => {
    expect(housenumberText('12 a').split(' ')).toContain('12a');
    expect(housenumberText('12 A').split(' ')).toContain('12a');
    expect(housenumberText('12a').split(' ')).toContain('12a');
  });

  it('keeps ranges and lists searchable as single numbers', () => {
    expect(housenumberText('12-14').split(' ')).toEqual(expect.arrayContaining(['12', '14']));
    expect(housenumberText('12;14').split(' ')).toEqual(expect.arrayContaining(['12', '14']));
  });

  it('returns an empty text without a house number', () => {
    expect(housenumberText(null)).toBe('');
  });
});

describe('street names written joined and split', () => {
  const words = (text: string) => indexText([text]).split(' ');

  it('also indexes "Friedrichstraße" split', () => {
    expect(words('Friedrichstraße')).toEqual(expect.arrayContaining(['friedrich', 'strasse']));
    expect(words('Lindenweg')).toEqual(expect.arrayContaining(['linden', 'weg']));
  });

  it('also indexes "Konrad-Adenauer-Straße" joined', () => {
    expect(words('Konrad-Adenauer-Straße')).toContain('adenauerstrasse');
    expect(words('Friedrich Straße')).toContain('friedrichstrasse');
  });

  it('keeps the double s in the split word for "Schloßstraße"', () => {
    expect(words('Schloßstraße')).toEqual(expect.arrayContaining(['schloss', 'strasse']));
    expect(words('Schloss Straße')).toContain(normalizeWord('Schloßstraße'));
  });

  it('does not add an s if the stem itself ends in s', () => {
    for (const [name, stem] of [
      ['Rathausstraße', 'rathaus'],
      ['Kreisstraße', 'kreis'],
      ['Bahnhofsstraße', 'bahnhofs'],
      ['Gaußstraße', 'gauss'],
    ] as const) {
      expect(words(name)).toEqual(expect.arrayContaining([stem, 'strasse']));
      expect(words(name)).not.toContain(`${stem}s`);
    }
  });

  it('does not attach base words to short words ("Am Ring")', () => {
    expect(words('Am Ring')).not.toContain('amring');
    expect(words('An der Allee')).not.toContain('derallee');
  });

  it('does not split off stems that are too short, nor numbers', () => {
    expect(words('Ring')).toEqual(['ring']);
    expect(words('Ostring')).not.toContain('os');
    expect(words('A 1 Weg')).not.toContain('1weg');
  });

  it('also compares the split form in the ranking', () => {
    expect(nameForms('Friedrichstraße')).toContain('friedrich strasse');
    expect(nameForms('Konrad-Adenauer-Straße')).toContain('konrad adenauerstrasse');
  });
});
