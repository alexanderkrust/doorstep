import { z } from 'zod';
import { normalizeTokens } from '../search/normalize.js';
import { parseResultTypes, RESULT_TYPE_LIST } from '../search/result-type.js';

export const MIN_QUERY_LENGTH = 2;
/** Longer queries are rejected: no address needs more, and each word costs search time. */
export const MAX_QUERY_LENGTH = 200;
export const MAX_LIMIT = 10;
export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_REVERSE_RADIUS_KM = 1;
export const MAX_REVERSE_RADIUS_KM = 10;

/** A single query parameter (parameters given more than once arrive as an array). */
const single = z.string({
  error: (issue) => (issue.input === undefined ? 'is required' : 'must be given only once'),
});

const integer = (min: number, max: number) =>
  single
    .trim()
    .regex(/^-?\d+$/, 'must be an integer')
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `must be at least ${String(min)}`)
        .max(max, `must be at most ${String(max)}`),
    );

const decimal = (min: number, max: number, exclusiveMin = false) =>
  single
    .trim()
    .regex(/^[-+]?(\d+\.?\d*|\.\d+)$/, 'must be a number')
    .transform(Number)
    .pipe(
      (exclusiveMin
        ? z.number().gt(min, `must be greater than ${String(min)}`)
        : z.number().min(min, `must be at least ${String(min)}`)
      ).max(max, `must be at most ${String(max)}`),
    );

const lat = decimal(-90, 90);
const lon = decimal(-180, 180);

const lang = single
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/, 'must be a two-letter language code (e.g. de)');

/** `types=street,poi`: only these result types. */
const types = single.transform((value, ctx) => {
  const parsed = parseResultTypes(value);
  if (parsed.unknown.length > 0 || parsed.types.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message:
        parsed.unknown.length > 0
          ? `unknown type ${parsed.unknown.join(', ')}; allowed: ${RESULT_TYPE_LIST}`
          : `must name at least one of: ${RESULT_TYPE_LIST}`,
    });
    return z.NEVER;
  }
  return parsed.types;
});

const query = single
  .trim()
  .min(MIN_QUERY_LENGTH, `must be at least ${String(MIN_QUERY_LENGTH)} characters long`)
  .max(MAX_QUERY_LENGTH, `must be at most ${String(MAX_QUERY_LENGTH)} characters long`)
  .refine((q) => normalizeTokens(q).length > 0, 'contains no searchable words');

export const searchParams = z
  .object({
    q: query,
    limit: integer(1, MAX_LIMIT).optional(),
    lat: lat.optional(),
    lon: lon.optional(),
    lang: lang.optional(),
    types: types.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.lat !== undefined && p.lon === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lon'],
        message: 'is required (lat and lon go together)',
      });
    }
    if (p.lon !== undefined && p.lat === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lat'],
        message: 'is required (lat and lon go together)',
      });
    }
  });

export const reverseParams = z.object({
  lat,
  lon,
  limit: integer(1, MAX_LIMIT).optional(),
  radius: decimal(0, MAX_REVERSE_RADIUS_KM, true).optional(),
  lang: lang.optional(),
  types: types.optional(),
});

/** "q: must be at least 2 characters long; limit: …" */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
    .join('; ');
}
