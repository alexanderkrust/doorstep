import { z } from 'zod';
import { tokenize } from '../search/query.js';

export const MIN_QUERY_LENGTH = 2;
export const MAX_LIMIT = 10;
export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_REVERSE_RADIUS_KM = 1;
export const MAX_REVERSE_RADIUS_KM = 10;

/** Ein einzelner Query-Parameter (mehrfach angegebene Parameter kommen als Array). */
const single = z.string({
  error: (issue) => (issue.input === undefined ? 'fehlt' : 'darf nur einmal angegeben werden'),
});

const integer = (min: number, max: number) =>
  single
    .trim()
    .regex(/^-?\d+$/, 'muss eine ganze Zahl sein')
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, `muss mindestens ${String(min)} sein`)
        .max(max, `darf höchstens ${String(max)} sein`),
    );

const decimal = (min: number, max: number, exclusiveMin = false) =>
  single
    .trim()
    .regex(/^[-+]?(\d+\.?\d*|\.\d+)$/, 'muss eine Zahl sein')
    .transform(Number)
    .pipe(
      (exclusiveMin
        ? z.number().gt(min, `muss größer als ${String(min)} sein`)
        : z.number().min(min, `muss mindestens ${String(min)} sein`)
      ).max(max, `darf höchstens ${String(max)} sein`),
    );

const lat = decimal(-90, 90);
const lon = decimal(-180, 180);

const lang = single
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/, 'muss ein zweistelliger Sprachcode sein (z. B. de)');

const query = single
  .trim()
  .min(MIN_QUERY_LENGTH, `muss mindestens ${String(MIN_QUERY_LENGTH)} Zeichen lang sein`)
  .refine((q) => tokenize(q).length > 0, 'enthält keine suchbaren Wörter');

export const searchParams = z
  .object({
    q: query,
    limit: integer(1, MAX_LIMIT).optional(),
    lat: lat.optional(),
    lon: lon.optional(),
    lang: lang.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.lat !== undefined && p.lon === undefined) {
      ctx.addIssue({ code: 'custom', path: ['lon'], message: 'fehlt (lat und lon nur gemeinsam)' });
    }
    if (p.lon !== undefined && p.lat === undefined) {
      ctx.addIssue({ code: 'custom', path: ['lat'], message: 'fehlt (lat und lon nur gemeinsam)' });
    }
  });

export const reverseParams = z.object({
  lat,
  lon,
  limit: integer(1, MAX_LIMIT).optional(),
  radius: decimal(0, MAX_REVERSE_RADIUS_KM, true).optional(),
  lang: lang.optional(),
});

/** "q: muss mindestens 2 Zeichen lang sein; limit: …" */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
    .join('; ');
}
