import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ValidationIssue } from "./types.js";

export const TEMPORAL_SEMANTIC_SCHEMA_VERSION = "temporal_semantic_v1" as const;
export const TEMPORAL_SEMANTIC_EXECUTOR_VERSION = "temporal_semantic_executor_ts_v1" as const;

export type TemporalAnswerShape =
  | "when"
  | "date_range"
  | "duration"
  | "recency"
  | "routine_time"
  | "relative_order"
  | "life_period";

export type TemporalSemanticClass =
  | "exact_date"
  | "month_year"
  | "date_range"
  | "duration"
  | "recency"
  | "routine_time"
  | "event_relative"
  | "life_period_reference"
  | "relative_order"
  | "vague_time"
  | "needs_anchor";

export interface TemporalSemanticRegistry {
  readonly version: string;
  readonly temporal_classes: readonly TemporalSemanticClass[];
  readonly answer_shapes: readonly TemporalAnswerShape[];
  readonly precision_levels: readonly string[];
  readonly rules?: Record<string, unknown>;
}

export interface TemporalSemanticPayload {
  readonly schemaVersion: typeof TEMPORAL_SEMANTIC_SCHEMA_VERSION;
  readonly executorVersion: typeof TEMPORAL_SEMANTIC_EXECUTOR_VERSION;
  readonly rawText: string;
  readonly temporalClass: TemporalSemanticClass;
  readonly anchorType: string;
  readonly anchorId: string | null;
  readonly precision: string;
  readonly normalizedStart: string | null;
  readonly normalizedEnd: string | null;
  readonly normalizedDuration: string | null;
  readonly normalizedValue: string | null;
  readonly answerableShapes: readonly TemporalAnswerShape[];
  readonly blockedShapes: readonly TemporalAnswerShape[];
  readonly needsClarification: boolean;
  readonly semanticStatus: "compiled" | "candidate" | "rejected" | "clarification_needed";
  readonly rejectionReason: string | null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
] as const;

function moduleRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function iso(date: Date): string {
  return date.toISOString();
}

function utcDate(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  return new Date(Date.UTC(year, monthIndex, day, hour, minute, second, ms));
}

function endOfDay(date: Date): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function numberFromWord(value: string | undefined): number | null {
  const normalized = normalizeText(value).toLowerCase();
  const table: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    couple: 2,
    few: 3
  };
  if (/^\d+$/u.test(normalized)) {
    return Number(normalized);
  }
  return table[normalized] ?? null;
}

function durationIso(count: number, unit: string): string {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("minute")) return `PT${count}M`;
  if (normalized.startsWith("hour")) return `PT${count}H`;
  if (normalized.startsWith("day")) return `P${count}D`;
  if (normalized.startsWith("week")) return `P${count}W`;
  if (normalized.startsWith("month")) return `P${count}M`;
  return `P${count}Y`;
}

function dayRange(date: Date): { readonly start: string; readonly end: string } {
  return {
    start: iso(utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())),
    end: iso(endOfDay(date))
  };
}

function monthRange(year: number, monthIndex: number): { readonly start: string; readonly end: string } {
  return {
    start: iso(utcDate(year, monthIndex, 1)),
    end: iso(utcDate(year, monthIndex + 1, 0, 23, 59, 59, 999))
  };
}

function makePayload(params: {
  readonly rawText: string;
  readonly temporalClass: TemporalSemanticClass;
  readonly anchorType: string;
  readonly anchorId?: string | null;
  readonly precision: string;
  readonly normalizedStart?: string | null;
  readonly normalizedEnd?: string | null;
  readonly normalizedDuration?: string | null;
  readonly normalizedValue?: string | null;
  readonly answerableShapes: readonly TemporalAnswerShape[];
  readonly blockedShapes: readonly TemporalAnswerShape[];
  readonly needsClarification?: boolean;
  readonly rejectionReason?: string | null;
}): TemporalSemanticPayload {
  const rejected = Boolean(params.rejectionReason);
  const clarification = params.needsClarification === true;
  return {
    schemaVersion: TEMPORAL_SEMANTIC_SCHEMA_VERSION,
    executorVersion: TEMPORAL_SEMANTIC_EXECUTOR_VERSION,
    rawText: params.rawText,
    temporalClass: params.temporalClass,
    anchorType: params.anchorType,
    anchorId: params.anchorId ?? null,
    precision: params.precision,
    normalizedStart: params.normalizedStart ?? null,
    normalizedEnd: params.normalizedEnd ?? null,
    normalizedDuration: params.normalizedDuration ?? null,
    normalizedValue: params.normalizedValue ?? null,
    answerableShapes: params.answerableShapes,
    blockedShapes: params.blockedShapes,
    needsClarification: clarification,
    semanticStatus: rejected ? "rejected" : clarification ? "clarification_needed" : "compiled",
    rejectionReason: params.rejectionReason ?? null
  };
}

export async function loadTemporalSemanticRegistry(version = "temporal_semantics.v1.json"): Promise<TemporalSemanticRegistry> {
  const filePath = path.resolve(moduleRoot(), "config/temporal", version);
  return JSON.parse(await readFile(filePath, "utf8")) as TemporalSemanticRegistry;
}

export function compileTemporalSemantic(params: {
  readonly rawText: string;
  readonly temporalType?: string | null;
  readonly granularity?: string | null;
  readonly anchorType?: string | null;
  readonly anchorId?: string | null;
  readonly sourceCapturedAt?: string | null;
  readonly knownEventAnchors?: readonly string[];
  readonly candidateIndex?: number;
}): { readonly semantic: TemporalSemanticPayload; readonly issues: readonly ValidationIssue[] } {
  const rawText = normalizeText(params.rawText);
  const lower = rawText.toLowerCase();
  const sourceDate = parseDate(params.sourceCapturedAt ?? null);
  const issues: ValidationIssue[] = [];

  const isoDate = lower.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/u);
  if (isoDate) {
    const parsed = parseDate(isoDate[0]);
    if (parsed) {
      const range = dayRange(parsed);
      return {
        semantic: makePayload({
          rawText,
          temporalClass: "exact_date",
          anchorType: "explicit",
          precision: "day",
          normalizedStart: range.start,
          normalizedEnd: range.end,
          normalizedValue: isoDate[0],
          answerableShapes: ["when"],
          blockedShapes: ["duration", "recency"]
        }),
        issues
      };
    }
  }

  const monthYear = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2}|19\d{2})\b/u
  );
  if (monthYear) {
    const range = monthRange(Number(monthYear[2]), MONTHS.indexOf(monthYear[1] as (typeof MONTHS)[number]));
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "month_year",
        anchorType: "explicit",
        precision: "month",
        normalizedStart: range.start,
        normalizedEnd: range.end,
        normalizedValue: `${monthYear[1]} ${monthYear[2]}`,
        answerableShapes: ["when", "date_range"],
        blockedShapes: ["duration", "recency"]
      }),
      issues
    };
  }

  const monthDay = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/u
  );
  if (monthDay) {
    if (!sourceDate) {
      issues.push({ code: "missing_source_date_anchor", message: "Month-day references need a source date year.", candidateIndex: params.candidateIndex });
      return {
        semantic: makePayload({
          rawText,
          temporalClass: "needs_anchor",
          anchorType: "source_captured_at",
          precision: "day",
          answerableShapes: [],
          blockedShapes: ["when", "date_range", "duration", "recency"],
          needsClarification: true,
          rejectionReason: "missing_source_date_anchor"
        }),
        issues
      };
    }
    const parsed = utcDate(sourceDate.getUTCFullYear(), MONTHS.indexOf(monthDay[1] as (typeof MONTHS)[number]), Number(monthDay[2]));
    const range = dayRange(parsed);
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "exact_date",
        anchorType: "source_captured_at",
        precision: "day",
        normalizedStart: range.start,
        normalizedEnd: range.end,
        normalizedValue: `${monthDay[1]} ${monthDay[2]}`,
        answerableShapes: ["when"],
        blockedShapes: ["duration", "recency"]
      }),
      issues
    };
  }

  if (/\b(?:today|yesterday)\b/u.test(lower)) {
    if (!sourceDate) {
      issues.push({ code: "missing_source_date_anchor", message: "Deictic day references need source captured_at.", candidateIndex: params.candidateIndex });
    }
    const target = sourceDate && /\byesterday\b/u.test(lower) ? addDays(sourceDate, -1) : sourceDate;
    const range = target ? dayRange(target) : null;
    return {
      semantic: makePayload({
        rawText,
        temporalClass: sourceDate ? "exact_date" : "needs_anchor",
        anchorType: "source_captured_at",
        precision: "day",
        normalizedStart: range?.start,
        normalizedEnd: range?.end,
        normalizedValue: lower.includes("yesterday") ? "yesterday" : "today",
        answerableShapes: sourceDate ? ["when"] : [],
        blockedShapes: ["duration", "recency"],
        needsClarification: !sourceDate,
        rejectionReason: sourceDate ? null : "missing_source_date_anchor"
      }),
      issues
    };
  }

  const endOfMonth = lower.match(/\bend of (january|february|march|april|may|june|july|august|september|october|november|december)\b/u);
  if (endOfMonth) {
    if (!sourceDate) {
      issues.push({ code: "missing_source_date_anchor", message: "End-of-month references need a source date year.", candidateIndex: params.candidateIndex });
      return {
        semantic: makePayload({
          rawText,
          temporalClass: "needs_anchor",
          anchorType: "source_captured_at",
          precision: "range",
          answerableShapes: [],
          blockedShapes: ["when", "date_range", "duration", "recency"],
          needsClarification: true,
          rejectionReason: "missing_source_date_anchor"
        }),
        issues
      };
    }
    const monthIndex = MONTHS.indexOf(endOfMonth[1] as (typeof MONTHS)[number]);
    const year = sourceDate.getUTCFullYear();
    const end = utcDate(year, monthIndex + 1, 0, 23, 59, 59, 999);
    const start = addDays(end, -6);
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "date_range",
        anchorType: "source_captured_at",
        precision: "range",
        normalizedStart: iso(utcDate(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())),
        normalizedEnd: iso(end),
        normalizedValue: `end of ${endOfMonth[1]} ${year}`,
        answerableShapes: ["when", "date_range"],
        blockedShapes: ["duration", "recency"]
      }),
      issues
    };
  }

  if (/\blast month\b/u.test(lower)) {
    if (!sourceDate) {
      issues.push({ code: "missing_source_date_anchor", message: "Last month needs source captured_at.", candidateIndex: params.candidateIndex });
      return {
        semantic: makePayload({
          rawText,
          temporalClass: "needs_anchor",
          anchorType: "source_captured_at",
          precision: "month",
          answerableShapes: [],
          blockedShapes: ["when", "date_range", "duration", "recency"],
          needsClarification: true,
          rejectionReason: "missing_source_date_anchor"
        }),
        issues
      };
    }
    const last = addMonths(sourceDate, -1);
    const range = monthRange(last.getUTCFullYear(), last.getUTCMonth());
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "date_range",
        anchorType: "source_captured_at",
        precision: "month",
        normalizedStart: range.start,
        normalizedEnd: range.end,
        normalizedValue: "last month",
        answerableShapes: ["when", "date_range"],
        blockedShapes: ["duration", "recency"]
      }),
      issues
    };
  }

  const recency = lower.match(/\b(?:(\d+)|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|a few)\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/u);
  if (recency) {
    if (!sourceDate) {
      issues.push({ code: "missing_source_date_anchor", message: "Recency references need source captured_at.", candidateIndex: params.candidateIndex });
    }
    const count = numberFromWord(recency[1] ?? recency[0].split(/\s+/u)[0]) ?? 3;
    const unit = recency[2];
    const precise = !/\bfew|couple|a few\b/u.test(recency[0]);
    const resolved = sourceDate
      ? unit.startsWith("month")
        ? addMonths(sourceDate, -count)
        : unit.startsWith("year")
          ? utcDate(sourceDate.getUTCFullYear() - count, sourceDate.getUTCMonth(), sourceDate.getUTCDate())
          : unit.startsWith("week")
            ? addDays(sourceDate, -count * 7)
            : unit.startsWith("day")
              ? addDays(sourceDate, -count)
              : sourceDate
      : null;
    const range = resolved ? dayRange(resolved) : null;
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "recency",
        anchorType: "source_captured_at",
        precision: precise ? "day" : "coarse",
        normalizedStart: precise ? range?.start : null,
        normalizedEnd: precise ? range?.end : null,
        normalizedValue: recency[0],
        answerableShapes: ["when", "recency"],
        blockedShapes: ["duration"],
        needsClarification: !sourceDate,
        rejectionReason: sourceDate ? null : "missing_source_date_anchor"
      }),
      issues
    };
  }

  const duration = lower.match(/\b(?:for\s+)?(?:(\d+)|one|two|three|four|five|six|seven|eight|nine|ten|couple|few|a few)\s+(minutes?|hours?|days?|weeks?|months?|years?)\b/u);
  if (duration) {
    const count = numberFromWord(duration[1] ?? duration[0].replace(/^for\s+/u, "").split(/\s+/u)[0]) ?? 3;
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "duration",
        anchorType: params.anchorType ?? "none",
        anchorId: params.anchorId ?? null,
        precision: "duration",
        normalizedDuration: durationIso(count, duration[2]),
        normalizedValue: duration[0],
        answerableShapes: ["duration"],
        blockedShapes: ["when", "recency"]
      }),
      issues
    };
  }

  const clock = lower.match(/\b(?:around\s+|about\s+)?([1-9]|1[0-2])(?::([0-5]\d))?\s*(am|pm)\b/u);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
    const minute = clock[2] ?? "00";
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "routine_time",
        anchorType: "clock",
        precision: clock[0].startsWith("around") || clock[0].startsWith("about") ? "coarse" : "exact",
        normalizedValue: `${String(hour).padStart(2, "0")}:${minute}`,
        answerableShapes: ["routine_time"],
        blockedShapes: ["duration", "recency", "date_range"]
      }),
      issues
    };
  }

  if (/\bevery\s+(?:morning|afternoon|evening|night|day|week)\b/u.test(lower) || /\b(?:morning|afternoon|evening|night)\b/u.test(lower)) {
    const part = lower.match(/\b(morning|afternoon|evening|night|day|week)\b/u)?.[1] ?? rawText;
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "routine_time",
        anchorType: "repeating",
        precision: "routine",
        normalizedValue: part,
        answerableShapes: ["routine_time"],
        blockedShapes: ["duration", "recency", "date_range"]
      }),
      issues
    };
  }

  if (/\b(?:after|before)\s+/u.test(lower)) {
    const knownAnchors = params.knownEventAnchors ?? [];
    const hasKnownAnchor = knownAnchors.some((anchor) => lower.includes(anchor.toLowerCase()));
    if (!hasKnownAnchor) {
      issues.push({ code: "missing_event_anchor", message: "Event-relative temporal phrase needs a known event anchor.", candidateIndex: params.candidateIndex });
    }
    return {
      semantic: makePayload({
        rawText,
        temporalClass: hasKnownAnchor ? "event_relative" : "needs_anchor",
        anchorType: hasKnownAnchor ? "known_event" : "none",
        anchorId: hasKnownAnchor ? knownAnchors.find((anchor) => lower.includes(anchor.toLowerCase())) ?? null : null,
        precision: "relative_order",
        normalizedValue: rawText,
        answerableShapes: hasKnownAnchor ? ["relative_order"] : [],
        blockedShapes: hasKnownAnchor ? ["duration", "recency"] : ["when", "date_range", "duration", "recency", "routine_time"],
        needsClarification: !hasKnownAnchor,
        rejectionReason: hasKnownAnchor ? null : "missing_event_anchor"
      }),
      issues
    };
  }

  if (/\b(?:recently|sometime|around then|when i was younger|last spring|last summer|last fall|last winter)\b/u.test(lower)) {
    return {
      semantic: makePayload({
        rawText,
        temporalClass: "vague_time",
        anchorType: "none",
        precision: "coarse",
        normalizedValue: rawText,
        answerableShapes: [],
        blockedShapes: ["when", "date_range", "duration", "recency", "routine_time"],
        needsClarification: true,
        rejectionReason: "vague_temporal_reference"
      }),
      issues
    };
  }

  return {
    semantic: makePayload({
      rawText,
      temporalClass: "needs_anchor",
      anchorType: params.anchorType ?? "none",
      anchorId: params.anchorId ?? null,
      precision: params.granularity ?? "unknown",
      normalizedValue: rawText || null,
      answerableShapes: [],
      blockedShapes: ["when", "date_range", "duration", "recency", "routine_time"],
      needsClarification: true,
      rejectionReason: "unsupported_temporal_semantics"
    }),
    issues: [{ code: "unsupported_temporal_semantics", message: "Temporal phrase is not executable by temporal_semantic_v1.", candidateIndex: params.candidateIndex }]
  };
}
