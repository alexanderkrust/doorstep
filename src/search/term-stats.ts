import type { DatabaseSync, StatementSync } from 'node:sqlite';

/** A word of the full-text index with the number of documents containing it. */
export interface TermDocs {
  term: string;
  docs: number;
}

/** Prefixes up to this length are precomputed in `prefixes` (like `prefix = '1 2 3 4'` in FTS5). */
export const MAX_INDEXED_PREFIX = 4;
/** Largest character: upper bound for "all words starting with …". */
const MAX_CHAR = '\u{10FFFF}';

/** Length in characters (like FTS5), not in UTF-16 units. */
export const charLength = (text: string) => Array.from(text).length;

/**
 * Word statistics from the import (tables `terms` and `prefixes`, meta `fts_tokens`):
 * document counts for bm25 and the words of a prefix for its expansion.
 */
export class TermStats {
  private constructor(
    /** Rows in the full-text index. */
    readonly rows: number,
    /** Average number of words per row across all columns. */
    readonly avgTokens: number,
    private readonly term: StatementSync,
    private readonly prefix: StatementSync,
    private readonly range: StatementSync,
    private readonly first: StatementSync,
    /** `fuzzy_deletes` lookup; `null` for an index from before SymSpell. */
    private readonly fuzzy: StatementSync | null,
  ) {}

  /** The index has the SymSpell table for the typo tolerance. */
  get hasFuzzyDeletes(): boolean {
    return this.fuzzy !== null;
  }

  /** Word starts in `fuzzy_deletes` with one of these deletions (see `fuzzyCorrections`). */
  fuzzyPrefixes(keys: readonly string[]): string[] {
    if (!this.fuzzy) return [];
    return (this.fuzzy.all(JSON.stringify(keys)) as { prefix: string }[]).map((r) => r.prefix);
  }

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
    const fuzzy =
      (
        db.prepare("SELECT value FROM meta WHERE key = 'fuzzy'").get() as
          { value?: string } | undefined
      )?.value === 'symspell'
        ? db.prepare(
            'SELECT DISTINCT prefix FROM fuzzy_deletes WHERE del IN (SELECT value FROM json_each(?))',
          )
        : null;
    return new TermStats(
      rows,
      rows > 0 ? tokens / rows : 1,
      db.prepare('SELECT docs FROM terms WHERE term = ?'),
      db.prepare('SELECT docs FROM prefixes WHERE prefix = ?'),
      db.prepare('SELECT term, docs FROM terms WHERE term >= ? AND term < ? ORDER BY term'),
      db.prepare('SELECT 1 AS found FROM terms WHERE term >= ? AND term < ? LIMIT 1'),
      fuzzy,
    );
  }

  /** Documents with exactly this word. */
  docs(term: string): number {
    return (this.term.get(term) as { docs?: number } | undefined)?.docs ?? 0;
  }

  /**
   * Documents with a word starting with `prefix`. Summed over the words: a document
   * with two such words counts twice; that is good enough for bm25.
   */
  prefixDocs(prefix: string, completions?: readonly TermDocs[]): number {
    if (charLength(prefix) <= MAX_INDEXED_PREFIX && completions === undefined) {
      return (this.prefix.get(prefix) as { docs?: number } | undefined)?.docs ?? 0;
    }
    return (completions ?? this.completions(prefix)).reduce((sum, t) => sum + t.docs, 0);
  }

  /** Is there a word that equals `token` or, with `prefix`, starts with it? */
  exists(token: string, prefix: boolean): boolean {
    if (!prefix) return this.docs(token) > 0;
    return this.first.get(token, token + MAX_CHAR) !== undefined;
  }

  /** All words starting with `prefix`, in alphabetical order. */
  completions(prefix: string): TermDocs[] {
    return this.range.all(prefix, prefix + MAX_CHAR) as unknown as TermDocs[];
  }
}
