import type { AssistantCandidate, ResolvedTemporalCandidate, TaxonomyRegistry, ValidationIssue } from "./types.js";
import { compileTemporalSemantic } from "./temporal-semantics.js";

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoDate(date: Date): string {
  return date.toISOString();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function durationFromText(raw: string): string | null {
  const match = raw.match(/\b(?:for\s+)?(?:(\d+)|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s+(day|days|week|weeks|month|months|year|years|hour|hours)\b/iu);
  return match?.[0] ? normalizeText(match[0]) : null;
}

function numberWordToNumber(value: string): number | null {
  const normalized = value.toLowerCase();
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
    couple: 2,
    few: 3
  };
  if (/^\d+$/u.test(normalized)) {
    return Number(normalized);
  }
  return table[normalized] ?? null;
}

function relativeToSource(raw: string, sourceCapturedAt: string | null): { start: string; end: string } | null {
  const anchor = parseDate(sourceCapturedAt);
  if (!anchor) {
    return null;
  }
  const match = raw.match(/\b(?:(\d+)|one|two|three|four|five|six|seven|eight|nine|ten|couple|few)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/iu);
  if (!match) {
    return null;
  }
  const count = numberWordToNumber(match[1] ?? match[0].split(/\s+/u)[0] ?? "");
  if (!count) {
    return null;
  }
  const unit = match[2]?.toLowerCase() ?? "";
  const days = unit.startsWith("day")
    ? count
    : unit.startsWith("week")
      ? count * 7
      : unit.startsWith("month")
        ? count * 30
        : count * 365;
  const resolved = addDays(anchor, -days);
  return { start: isoDate(resolved), end: isoDate(resolved) };
}

function endOfYear(year: number): string {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString();
}

function startOfYear(year: number): string {
  return new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)).toISOString();
}

function monthRange(year: number, monthIndex: number): { start: string; end: string } {
  return {
    start: new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0)).toISOString(),
    end: new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999)).toISOString()
  };
}

function parseExplicitRange(raw: string): { start: string; end: string; granularity: string } | null {
  const date = raw.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/u);
  if (date) {
    const parsed = parseDate(date[0]);
    return parsed ? { start: isoDate(parsed), end: isoDate(parsed), granularity: "day" } : null;
  }
  const month = raw.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2}|19\d{2})\b/iu);
  if (month) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    return { ...monthRange(Number(month[2]), months.indexOf(month[1].toLowerCase())), granularity: "month" };
  }
  const year = raw.match(/\b(20\d{2}|19\d{2})\b/u);
  if (year) {
    const parsedYear = Number(year[1]);
    return { start: startOfYear(parsedYear), end: endOfYear(parsedYear), granularity: "year" };
  }
  return null;
}

export function resolveTemporalCandidate(params: {
  readonly registry: TaxonomyRegistry;
  readonly candidate: AssistantCandidate;
  readonly sourceCapturedAt: string | null;
  readonly candidateIndex: number;
}): { readonly temporal: ResolvedTemporalCandidate | null; readonly issues: readonly ValidationIssue[] } {
  const temporal = params.candidate.temporal;
  if (!temporal) {
    return { temporal: null, issues: [] };
  }

  const rawText = normalizeText(temporal.raw_text);
  const temporalType = normalizeText(temporal.temporal_type || temporal.temporal_class || "unknown");
  const granularity = normalizeText(temporal.granularity || "unknown") || "unknown";
  const anchorType = normalizeText(temporal.anchor_type || "none") || "none";
  const issues: ValidationIssue[] = [];

  if (!params.registry.temporal_types.includes(temporalType)) {
    issues.push({
      code: "unknown_temporal_type",
      message: `Unknown temporal_type: ${temporalType}`,
      candidateIndex: params.candidateIndex
    });
  }

  let normalizedStart = temporal.normalized_range?.start ?? null;
  let normalizedEnd = temporal.normalized_range?.end ?? null;
  let rejectionReason: string | null = null;
  let needsClarification = temporal.needs_clarification === true;
  const semantic = compileTemporalSemantic({
    rawText,
    temporalType,
    granularity,
    anchorType,
    anchorId: temporal.anchor_id ?? null,
    sourceCapturedAt: params.sourceCapturedAt,
    candidateIndex: params.candidateIndex
  });
  issues.push(...semantic.issues);

  const explicit = parseExplicitRange(rawText);
  if ((!normalizedStart || !normalizedEnd) && explicit) {
    normalizedStart = explicit.start;
    normalizedEnd = explicit.end;
  }

  if (temporalType === "relative_to_source_date") {
    const resolved = relativeToSource(rawText, params.sourceCapturedAt);
    if (resolved) {
      normalizedStart = resolved.start;
      normalizedEnd = resolved.end;
    } else {
      needsClarification = true;
      rejectionReason = "missing_source_date_anchor";
    }
  }

  if (!normalizedStart && semantic.semantic.normalizedStart) {
    normalizedStart = semantic.semantic.normalizedStart;
  }
  if (!normalizedEnd && semantic.semantic.normalizedEnd) {
    normalizedEnd = semantic.semantic.normalizedEnd;
  }
  if (semantic.semantic.needsClarification) {
    needsClarification = true;
  }
  if (!rejectionReason && semantic.semantic.rejectionReason) {
    rejectionReason = semantic.semantic.rejectionReason;
  }

  if (temporalType === "duration" && !durationFromText(rawText)) {
    issues.push({ code: "invalid_duration_shape", message: "Duration temporal lacks quantity + unit.", candidateIndex: params.candidateIndex });
    rejectionReason = "invalid_duration_shape";
  }

  if ((temporalType === "relative_to_known_event" || temporalType === "relative_to_unknown_event") && anchorType === "none") {
    needsClarification = true;
    rejectionReason = "missing_event_anchor";
  }

  if (granularity === "day" && !parseExplicitRange(rawText) && temporalType !== "relative_to_source_date") {
    issues.push({
      code: "unsupported_temporal_precision_upgrade",
      message: "Day granularity requires explicit day support or source-relative arithmetic.",
      candidateIndex: params.candidateIndex
    });
    rejectionReason = "unsupported_precision_upgrade";
  }

  return {
    temporal: {
      rawText,
      temporalType,
      temporalClass: semantic.semantic.temporalClass,
      normalizedStart,
      normalizedEnd,
      normalizedDuration: temporal.normalized_duration ?? semantic.semantic.normalizedDuration,
      normalizedValue: temporal.normalized_value ?? semantic.semantic.normalizedValue,
      granularity,
      precision: temporal.precision ?? semantic.semantic.precision,
      anchorType,
      anchorId: temporal.anchor_id ?? null,
      answerableShapes: temporal.answerable_shapes ?? semantic.semantic.answerableShapes,
      blockedShapes: temporal.blocked_shapes ?? semantic.semantic.blockedShapes,
      needsClarification,
      confidence: params.candidate.confidence?.llm_temporal ?? params.candidate.confidence?.overall ?? null,
      rejectionReason: temporal.rejection_reason ?? rejectionReason,
      semanticStatus: semantic.semantic.semanticStatus,
      semanticPayload: semantic.semantic as unknown as Record<string, unknown>
    },
    issues
  };
}
