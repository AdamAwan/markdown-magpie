// --- Cron scheduling -------------------------------------------------------
// A small, dependency-free evaluator for standard 5-field cron expressions:
//   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6)
// Supports "*", lists (a,b), ranges (a-b), and steps (*/n, a-b/n). Sunday is 0
// (7 is also accepted as Sunday). Times are evaluated in local time.
//
// Caveat: evaluation is in local wall-clock time and nextCronTime scans
// minute-by-minute, so around DST transitions a "skipped" local hour can be
// missed and a "repeated" local hour can match twice. Acceptable for the
// coarse maintenance schedules this drives; revisit if minute-precision
// correctness across DST is ever required.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCronField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const rangePart = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2], 10) : 1;
    if (step <= 0) {
      return undefined;
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range) {
        lo = Number.parseInt(range[1], 10);
        hi = Number.parseInt(range[2], 10);
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number.parseInt(rangePart, 10);
        hi = lo;
      } else {
        return undefined;
      }
    }

    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : undefined;
}

function parseCronExpression(expr: string): CronFields | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return undefined;
  }

  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*"
  };
}

export function isValidCron(expr: string): boolean {
  return parseCronExpression(expr) !== undefined;
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) {
    return false;
  }
  if (!fields.hour.has(date.getHours())) {
    return false;
  }
  if (!fields.month.has(date.getMonth() + 1)) {
    return false;
  }

  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  // Vixie-cron rule: when both day-of-month and day-of-week are restricted, a
  // match on either one counts; otherwise both must match.
  if (fields.domRestricted && fields.dowRestricted) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

// The next minute that matches `expr`, strictly after `from`, or undefined if the
// expression is invalid (or — practically never — has no match within a year).
export function nextCronTime(expr: string, from: Date): Date | undefined {
  const fields = parseCronExpression(expr);
  if (!fields) {
    return undefined;
  }

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (cronMatches(fields, candidate)) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}
