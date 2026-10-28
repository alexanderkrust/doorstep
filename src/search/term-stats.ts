import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** Ein Wort des Volltextindex mit der Zahl der Dokumente, die es enthalten. */
export interface TermDocs {
  term: string;
  docs: number;
}

/** Präfixe bis zu dieser Länge stehen vorberechnet in `prefixes` (wie `prefix = '1 2 3 4'` in FTS5). */
export const MAX_INDEXED_PREFIX = 4;
/** Größtes Zeichen: Obergrenze für „alle Wörter, die mit … beginnen“. */
const MAX_CHAR = '\u{10FFFF}';

/** Länge in Zeichen (wie FTS5), nicht in UTF-16-Einheiten. */
export const charLength = (text: string) => Array.from(text).length;

/**
 * Wortstatistik aus dem Import (Tabellen `terms` und `prefixes`, Meta `fts_tokens`):
 * Dokumentzahlen für bm25 und die Wörter eines Präfixes für dessen Zerlegung.
 */
export class TermStats {
  private constructor(
    /** Zeilen im Volltextindex. */
    readonly rows: number,
    /** Mittlere Zahl der Wörter je Zeile über alle Spalten. */
    readonly avgTokens: number,
    private readonly term: StatementSync,
    private readonly prefix: StatementSync,
    private readonly range: StatementSync,
  ) {}

  static open(db: DatabaseSync): TermStats {
    const meta = (key: string) =>
      Number(
        (
          db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
            { value?: string } | undefined
        )?.value ?? 0,
      );
    const rows = meta('places');
    const tokens = meta('fts_tokens');
    return new TermStats(
      rows,
      rows > 0 ? tokens / rows : 1,
      db.prepare('SELECT docs FROM terms WHERE term = ?'),
      db.prepare('SELECT docs FROM prefixes WHERE prefix = ?'),
      db.prepare('SELECT term, docs FROM terms WHERE term >= ? AND term < ? ORDER BY term'),
    );
  }

  /** Dokumente mit genau diesem Wort. */
  docs(term: string): number {
    return (this.term.get(term) as { docs?: number } | undefined)?.docs ?? 0;
  }

  /**
   * Dokumente mit einem Wort, das mit `prefix` beginnt. Summe über die Wörter:
   * Ein Dokument mit zwei solchen Wörtern zählt doppelt; für bm25 genügt das.
   */
  prefixDocs(prefix: string, completions?: readonly TermDocs[]): number {
    if (charLength(prefix) <= MAX_INDEXED_PREFIX && completions === undefined) {
      return (this.prefix.get(prefix) as { docs?: number } | undefined)?.docs ?? 0;
    }
    return (completions ?? this.completions(prefix)).reduce((sum, t) => sum + t.docs, 0);
  }

  /** Alle Wörter, die mit `prefix` beginnen, alphabetisch. */
  completions(prefix: string): TermDocs[] {
    return this.range.all(prefix, prefix + MAX_CHAR) as unknown as TermDocs[];
  }
}
