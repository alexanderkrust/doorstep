import { readFileSync } from 'node:fs';

/** Liest die Version aus package.json (funktioniert aus src/ und dist/). */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
