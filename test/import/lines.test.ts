import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readLines } from '../../src/import/lines.js';

async function collect(chunks: (string | Buffer)[]): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readLines(Readable.from(chunks))) lines.push(line);
  return lines;
}

describe('readLines', () => {
  it('splits only at \\n, not at \\r, U+2028 or U+2029', async () => {
    expect(await collect(['a b\nc\rd e\nf'])).toEqual(['a b', 'c\rd e', 'f']);
  });

  it('joins lines across chunk boundaries', async () => {
    expect(await collect(['ab', 'c\nd', 'e\n'])).toEqual(['abc', 'de']);
  });

  it('does not break multibyte characters at chunk boundaries', async () => {
    const bytes = Buffer.from('Königsallee\n');
    expect(await collect([bytes.subarray(0, 2), bytes.subarray(2)])).toEqual(['Königsallee']);
  });
});
