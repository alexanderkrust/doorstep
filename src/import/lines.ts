import type { Readable } from 'node:stream';

/**
 * Yields the lines of a stream, split only at `\n`.
 * `readline` also splits at `\r`, U+2028 and U+2029, which occur in OSM tags and are
 * allowed unescaped in JSON strings.
 */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const parts = (rest + text).split('\n');
    rest = parts.pop() ?? '';
    yield* parts;
  }
  rest += decoder.decode();
  if (rest !== '') yield rest;
}
