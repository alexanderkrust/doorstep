import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  expandPrefix,
  inTextColumns,
  phrasesFor,
  queryVariants,
  tokenVariants,
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

describe('buildFtsQuery mit zerlegtem Präfix', () => {
  it('ersetzt das Präfix durch die Teile, verknüpft mit AND', () => {
    expect(buildFtsQuery(['breite', 'strasse'], ['"strasse"', '"strassen"*'])).toBe(
      '"breite" AND ("strasse" OR "strassen"*)',
    );
    expect(buildFtsQuery(['strasse'], ['"strasse"', '"strassen"*'])).toBe(
      '("strasse" OR "strassen"*)',
    );
  });

  it('behält die Postleitzahl-Ausnahme für Hausnummern', () => {
    expect(buildFtsQuery(['weg', '12a'], ['"12a"', '"12ab"*'])).toBe(
      '"weg" AND - {postcode} : ("12a" OR "12ab"*)',
    );
  });
});

describe('expandPrefix', () => {
  const terms = [
    { term: 'strasse', docs: 1000 },
    { term: 'strassen', docs: 5 },
    { term: 'strassenbahn', docs: 2 },
    { term: 'strasser', docs: 3 },
    { term: 'strassburg', docs: 40 },
    { term: 'strasbourg', docs: 20 },
  ];
  const completions = (prefix: string) => terms.filter((t) => t.term.startsWith(prefix));

  it('lässt Präfixe ohne häufiges Wort unverändert', () => {
    expect(expandPrefix('strassen', completions('strassen'), 100)).toBeNull();
    expect(expandPrefix('xyz', [], 100)).toBeNull();
  });

  it('sucht das häufige Wort exakt und den Rest über längere Präfixe', () => {
    expect(expandPrefix('strasse', completions('strasse'), 100)).toEqual([
      '"strasse"',
      '"strassen"*',
      '"strasser"',
    ]);
  });

  it('zerlegt schrittweise bis zum häufigen Wort', () => {
    expect(expandPrefix('stras', completions('stras'), 100)).toEqual([
      '"strasb"*',
      '"strassb"*',
      '"strasse"',
      '"strassen"*',
      '"strasser"',
    ]);
  });

  it('deckt genau die Wörter des Präfixes ab', () => {
    const parts = expandPrefix('stras', completions('stras'), 10) ?? [];
    const covers = (part: string, term: string) =>
      part.endsWith('*') ? term.startsWith(part.slice(1, -2)) : term === part.slice(1, -1);
    for (const t of completions('stras')) {
      expect(parts.filter((p) => covers(p, t.term))).toHaveLength(1);
    }
  });

  it('maskiert Anführungszeichen', () => {
    const quoted = [
      { term: 'a"', docs: 10 },
      { term: 'a"b', docs: 1 },
    ];
    expect(expandPrefix('a"', quoted, 5)).toEqual(['"a"""', '"a""b"']);
  });
});

describe('tokenVariants', () => {
  it('liefert die Wörter der Anfrage und der Tippfehler-Varianten', () => {
    expect(tokenVariants(['koe', 'abcd'])).toEqual([
      ['koe', 'abcd'],
      ['koe', 'abc'],
    ]);
    expect(tokenVariants([])).toEqual([]);
  });
});

describe('phrasesFor', () => {
  it('sucht das letzte Wort als Präfix', () => {
    expect(phrasesFor(['breite', 'str'])).toEqual([
      { token: 'breite', prefix: false, notInPostcode: false },
      { token: 'str', prefix: true, notInPostcode: false },
    ]);
  });

  it('sucht eine angefangene Hausnummer nicht in der Postleitzahl', () => {
    expect(phrasesFor(['weg', '4'])[1]).toEqual({ token: '4', prefix: true, notInPostcode: true });
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
