/**
 * Minimaler Cron-Parser für `UPDATE_CRON`: fünf Felder (Minute, Stunde, Tag,
 * Monat, Wochentag) mit `*`, Zahlen, Listen (`1,15`), Bereichen (`1-5`) und
 * Schritten (`*\/15`, `1-12/3`). Zeiten gelten in der lokalen Zeitzone des
 * Prozesses (im Container meist UTC, steuerbar über `TZ`).
 */

export class CronError extends Error {
  override name = 'CronError';
}

export interface CronSchedule {
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sonntag; 7 wird beim Parsen zu 0. */
  readonly weekdays: ReadonlySet<number>;
  /** Ist das Feld eingeschränkt (nicht `*`)? Wichtig für die Tag/Wochentag-Regel. */
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Stunde', min: 0, max: 23 },
  { name: 'Tag', min: 1, max: 31 },
  { name: 'Monat', min: 1, max: 12 },
  { name: 'Wochentag', min: 0, max: 7 },
];

function parseNumber(text: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(text)) {
    throw new CronError(`${spec.name}: "${text}" ist keine Zahl`);
  }
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new CronError(
      `${spec.name}: ${text} liegt nicht zwischen ${String(spec.min)} und ${String(spec.max)}`,
    );
  }
  return n;
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range = '', stepText, ...rest] = part.split('/');
    if (rest.length > 0) throw new CronError(`${spec.name}: "${part}" ist ungültig`);
    const step = stepText === undefined ? 1 : parseNumber(stepText, { ...spec, min: 1, max: 99 });

    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      from = parseNumber(a, spec);
      to = parseNumber(b, spec);
      if (from > to) throw new CronError(`${spec.name}: Bereich "${range}" ist umgekehrt`);
    } else {
      from = parseNumber(range, spec);
      to = stepText === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== FIELDS.length) {
    throw new CronError(
      `Erwartet werden 5 Felder (Minute Stunde Tag Monat Wochentag), gefunden: ${String(fields.length)}`,
    );
  }
  const [minutes, hours, days, months, weekdays] = FIELDS.map((spec, i) =>
    parseField(fields[i] ?? '', spec),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);

  return {
    expression: fields.join(' '),
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysRestricted: fields[2] !== '*',
    weekdaysRestricted: fields[4] !== '*',
  };
}

/** Passt der Tag? Sind Tag und Wochentag beide eingeschränkt, reicht eins (wie bei cron). */
function dayMatches(s: CronSchedule, date: Date): boolean {
  const day = s.days.has(date.getDate());
  const weekday = s.weekdays.has(date.getDay());
  if (s.daysRestricted && s.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

/** Spätestens nach so vielen Jahren gilt ein Zeitplan als "trifft nie zu" (z. B. 31. Februar). */
const MAX_YEARS = 5;

/** Nächster Zeitpunkt nach `after` (volle Minute, lokale Zeit). */
export function nextRun(schedule: CronSchedule, after: Date): Date {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getFullYear() + MAX_YEARS;

  while (t.getFullYear() <= limit) {
    if (!schedule.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(schedule, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new CronError(`Zeitplan "${schedule.expression}" trifft nie zu`);
}
