/**
 * Kleiner LRU-Cache auf Basis der Einfügereihenfolge einer `Map`: Der erste
 * Eintrag ist immer der am längsten nicht genutzte.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.maxSize <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
