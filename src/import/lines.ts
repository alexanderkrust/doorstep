import type { Readable } from 'node:stream';

/**
 * Liefert die Zeilen eines Streams, getrennt nur an `\n`.
 * `readline` trennt zusätzlich an `\r`, U+2028 und U+2029, die in OSM-Tags vorkommen
 * und in JSON-Strings unescaped erlaubt sind.
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
