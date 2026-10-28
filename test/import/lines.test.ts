import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readLines } from '../../src/import/lines.js';

async function collect(chunks: (string | Buffer)[]): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readLines(Readable.from(chunks))) lines.push(line);
  return lines;
}

describe('readLines', () => {
  it('trennt nur an \\n, nicht an \\r, U+2028 oder U+2029', async () => {
    expect(await collect(['a b\nc\rd e\nf'])).toEqual(['a b', 'c\rd e', 'f']);
  });

  it('setzt Zeilen über Chunk-Grenzen zusammen', async () => {
    expect(await collect(['ab', 'c\nd', 'e\n'])).toEqual(['abc', 'de']);
  });

  it('zerlegt Multibyte-Zeichen an Chunk-Grenzen nicht', async () => {
    const bytes = Buffer.from('Königsallee\n');
    expect(await collect([bytes.subarray(0, 2), bytes.subarray(2)])).toEqual(['Königsallee']);
  });
});
