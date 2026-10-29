/**
 * Minimal cron parser for `UPDATE_CRON`: five fields (minute, hour, day of month,
 * month, day of week) with `*`, numbers, lists (`1,15`), ranges (`1-5`) and
 * steps (`*\/15`, `1-12/3`). Times are in the process's local time zone
 * (usually UTC in the container, configurable via `TZ`).
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
  /** 0 = Sunday; 7 becomes 0 when parsing. */
  readonly weekdays: ReadonlySet<number>;
  /** Is the field restricted (not `*`)? Matters for the day/weekday rule. */
  readonly daysRestricted: boolean;
  readonly weekdaysRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

function parseNumber(text: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(text)) {
    throw new CronError(`${spec.name}: "${text}" is not a number`);
  }
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new CronError(
      `${spec.name}: ${text} is not between ${String(spec.min)} and ${String(spec.max)}`,
    );
  }
  return n;
}

function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range = '', stepText, ...rest] = part.split('/');
    if (rest.length > 0) throw new CronError(`${spec.name}: "${part}" is invalid`);
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
      if (from > to) throw new CronError(`${spec.name}: range "${range}" is reversed`);
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
      `Expected 5 fields (minute hour day month weekday), found: ${String(fields.length)}`,
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

/** Does the day match? If day and weekday are both restricted, either is enough (as in cron). */
function dayMatches(s: CronSchedule, date: Date): boolean {
  const day = s.days.has(date.getDate());
  const weekday = s.weekdays.has(date.getDay());
  if (s.daysRestricted && s.weekdaysRestricted) return day || weekday;
  return day && weekday;
}

/** After this many years at most, a schedule counts as "never matches" (e.g. February 31). */
const MAX_YEARS = 5;

/** Next point in time after `after` (full minute, local time). */
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
  throw new CronError(`Schedule "${schedule.expression}" never matches`);
}
