import { describe, expect, it } from 'vitest';
import { kindToken, RESULT_TYPES, resultType } from '../../src/search/result-type.js';

describe('resultType', () => {
  it.each([
    ['house', false, 'address'],
    ['house', true, 'poi'],
    ['street', false, 'street'],
    ['square', true, 'street'],
    ['poi', true, 'poi'],
    ['city', true, 'locality'],
    ['village', true, 'locality'],
    ['suburb', true, 'sublocality'],
    ['quarter', true, 'sublocality'],
    ['island', true, 'place'],
  ] as const)('maps %s (named: %s) to %s', (type, named, expected) => {
    expect(resultType(type, named)).toBe(expected);
  });
});

describe('kindToken', () => {
  it('gives every result type its own token for the full-text index', () => {
    const tokens = RESULT_TYPES.map(kindToken);
    expect(new Set(tokens).size).toBe(RESULT_TYPES.length);
    // One lowercase word, so the unicode61 tokenizer keeps it as it is.
    for (const token of tokens) expect(token).toMatch(/^[a-z]+$/);
  });
});
