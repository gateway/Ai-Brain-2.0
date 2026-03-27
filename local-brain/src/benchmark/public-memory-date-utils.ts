const MONTH_LOOKUP = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11]
]);

export function parseLoCoMoSessionDateTimeToIso(value: string): string | null {
  const match = value.match(
    /\b(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),\s+(19\d{2}|20\d{2})\b/i
  );
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  const day = Number.parseInt(match[4] ?? "", 10);
  const monthIndex = MONTH_LOOKUP.get((match[5] ?? "").toLowerCase());
  const year = Number.parseInt(match[6] ?? "", 10);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(day) ||
    monthIndex === undefined ||
    !Number.isFinite(year)
  ) {
    return null;
  }

  const normalizedHour = meridiem === "pm" ? (hour % 12) + 12 : hour % 12;
  return new Date(Date.UTC(year, monthIndex, day, normalizedHour, minute, 0, 0)).toISOString();
}

export function normalizeBenchmarkCapturedAt(value: unknown, fallbackIso: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallbackIso;
  }

  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  const year = parsed.getUTCFullYear();
  if (!Number.isFinite(timestamp) || Number.isNaN(timestamp) || year < 1900 || year > 2100) {
    return fallbackIso;
  }

  return parsed.toISOString();
}
