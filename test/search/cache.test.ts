import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/search/cache.js';

describe('LruCache', () => {
  it('liefert gespeicherte Werte', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('verdrängt den am längsten nicht genutzten Eintrag', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a ist jetzt der jüngste
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('überschreibt vorhandene Schlüssel ohne zu wachsen', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.get('a')).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('speichert bei Größe 0 nichts', () => {
    const cache = new LruCache<string, number>(0);
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('leert sich per clear()', () => {
    const cache = new LruCache<string, number>(5);
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
