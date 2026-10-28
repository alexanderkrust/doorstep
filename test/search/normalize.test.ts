import { describe, expect, it } from 'vitest';
import {
  housenumberText,
  indexText,
  nameForms,
  normalizeTokens,
  normalizeWord,
} from '../../src/search/normalize.js';

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

  it('behandelt "Schlosstr" wie "Schloßstraße" (drei s werden zu zwei)', () => {
    expect(normalizeWord('Schlosstr')).toBe(normalizeWord('Schloßstraße'));
    expect(normalizeWord('Schlossstrasse')).toBe(normalizeWord('Schloßstraße'));
    // Angefangene Eingabe bleibt ein Präfix des Namens
    expect(normalizeWord('Schloßstraße').startsWith(normalizeWord('Schlossst'))).toBe(true);
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

  it('trennt eine ohne Leerzeichen angehängte Hausnummer ab', () => {
    expect(normalizeTokens('friedrichstraße43 berlin')).toEqual([
      'friedrichstrasse',
      '43',
      'berlin',
    ]);
    expect(normalizeTokens('Hauptstr12a')).toEqual(['hauptstrasse', '12a']);
    // Kurze Bezeichnungen wie Autobahnen bleiben zusammen
    expect(normalizeTokens('A7')).toEqual(['a7']);
  });

  it('schreibt "St." vor einem weiteren Wort als "Sankt" aus', () => {
    expect(normalizeTokens('St. Augustin')).toEqual(['sankt', 'augustin']);
    expect(normalizeTokens('Sankt Augustin')).toEqual(['sankt', 'augustin']);
    // Als letztes Wort ist "st" ein angefangenes Wort ("Stuttgart")
    expect(normalizeTokens('St')).toEqual(['st']);
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
    expect(indexText(['Graf-Adolf-Str.'])).toBe('graf adolf strasse adolfstrasse');
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

describe('indexText und nameForms', () => {
  it('indexiert "St." als "Sankt"', () => {
    expect(indexText(['St. Pauli']).split(' ')).toContain('sankt');
    expect(nameForms('St. Ingbert')).toContain('sankt ingbert');
  });
});

describe('housenumberText', () => {
  it('indexiert "12 a" auch als "12a", damit beide Schreibweisen passen', () => {
    expect(housenumberText('12 a').split(' ')).toContain('12a');
    expect(housenumberText('12 A').split(' ')).toContain('12a');
    expect(housenumberText('12a').split(' ')).toContain('12a');
  });

  it('lässt Bereiche und Listen als einzelne Nummern suchbar', () => {
    expect(housenumberText('12-14').split(' ')).toEqual(expect.arrayContaining(['12', '14']));
    expect(housenumberText('12;14').split(' ')).toEqual(expect.arrayContaining(['12', '14']));
  });

  it('liefert einen leeren Text ohne Hausnummer', () => {
    expect(housenumberText(null)).toBe('');
  });
});

describe('zusammen- und getrennt geschriebene Straßennamen', () => {
  const words = (text: string) => indexText([text]).split(' ');

  it('indexiert "Friedrichstraße" auch getrennt', () => {
    expect(words('Friedrichstraße')).toEqual(expect.arrayContaining(['friedrich', 'strasse']));
    expect(words('Lindenweg')).toEqual(expect.arrayContaining(['linden', 'weg']));
  });

  it('indexiert "Konrad-Adenauer-Straße" auch zusammengeschrieben', () => {
    expect(words('Konrad-Adenauer-Straße')).toContain('adenauerstrasse');
    expect(words('Friedrich Straße')).toContain('friedrichstrasse');
  });

  it('behält bei "Schloßstraße" das Doppel-s im getrennten Wort', () => {
    expect(words('Schloßstraße')).toEqual(expect.arrayContaining(['schloss', 'strasse']));
    expect(words('Schloss Straße')).toContain(normalizeWord('Schloßstraße'));
  });

  it('hängt kein s an, wenn der Wortanfang selbst auf s endet', () => {
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

  it('hängt Grundwörter nicht an kurze Wörter an ("Am Ring")', () => {
    expect(words('Am Ring')).not.toContain('amring');
    expect(words('An der Allee')).not.toContain('derallee');
  });

  it('trennt keine zu kurzen Wortanfänge und keine Zahlen', () => {
    expect(words('Ring')).toEqual(['ring']);
    expect(words('Ostring')).not.toContain('os');
    expect(words('A 1 Weg')).not.toContain('1weg');
  });

  it('vergleicht im Ranking auch die getrennte Form', () => {
    expect(nameForms('Friedrichstraße')).toContain('friedrich strasse');
    expect(nameForms('Konrad-Adenauer-Straße')).toContain('konrad adenauerstrasse');
  });
});
