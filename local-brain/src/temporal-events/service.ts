import * as chrono from "chrono-node";
import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";
import {
  extractAtomicExactDetailValue,
  inferExactDetailFamilyFromSource
} from "../retrieval/exact-detail-fact-keys.js";

type JsonRecord = Record<string, unknown>;

export type TemporalEventExactness = "exact" | "bounded" | "inferred";
export type TemporalEventTruthStatus = "active" | "superseded" | "uncertain";

export interface TemporalEventFact {
  readonly id: string;
  readonly namespaceId: string;
  readonly contractName: string;
  readonly subjectEntityId: string | null;
  readonly pairSubjectEntityId: string | null;
  readonly eventKey: string;
  readonly eventLabel: string | null;
  readonly eventType: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly timeGranularity: string | null;
  readonly exactness: TemporalEventExactness;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly truthStatus: TemporalEventTruthStatus;
  readonly supportCount: number;
  readonly metadata: JsonRecord;
}

export interface TemporalEventSupport {
  readonly id: string;
  readonly temporalEventFactId: string;
  readonly supportTable: string;
  readonly sourceRowId: string | null;
  readonly supportMemoryId: string | null;
  readonly supportRole: "primary" | "support" | "conflict";
  readonly snippet: string | null;
  readonly occurredAt: string | null;
  readonly metadata: JsonRecord;
}

export interface ParsedDurationValue {
  readonly rawText: string;
  readonly approximateSeconds: number;
  readonly normalizedUnit: "minute" | "hour" | "day" | "week" | "month" | "year";
  readonly approximate: boolean;
}

export interface TemporalEventRebuildSummary {
  readonly namespaceId: string;
  readonly facts: number;
  readonly supports: number;
}

interface CanonicalTemporalFactSourceRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly subject_entity_id: string | null;
  readonly object_entity_id: string | null;
  readonly predicate_family: string;
  readonly event_key: string | null;
  readonly event_type: string | null;
  readonly fact_value: string | null;
  readonly anchor_text: string | null;
  readonly anchor_start: string | null;
  readonly anchor_end: string | null;
  readonly t_valid_from: string | null;
  readonly t_valid_until: string | null;
  readonly time_granularity: string | null;
  readonly answer_year: number | null;
  readonly answer_month: number | null;
  readonly answer_day: number | null;
  readonly confidence: number | null;
  readonly support_kind: string | null;
  readonly temporal_source_quality: string | null;
  readonly source_artifact_id: string | null;
  readonly source_chunk_id: string | null;
  readonly metadata: JsonRecord | null;
}

interface ParsedTemporalWindow {
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly timeGranularity: string | null;
  readonly exactness: TemporalEventExactness;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: string | null | undefined): string {
  return normalize(value).toLowerCase();
}

function readUuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function minIso(values: readonly (string | null | undefined)[]): string | null {
  const filtered = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (filtered.length === 0) {
    return null;
  }
  return [...filtered].sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function maxIso(values: readonly (string | null | undefined)[]): string | null {
  const filtered = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (filtered.length === 0) {
    return null;
  }
  return [...filtered].sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function toIso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

function endOfYear(year: number): Date {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function startOfDayUtc(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).toISOString();
}

function endOfDayUtc(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)).toISOString();
}

function parseNamedMonth(value: string | null | undefined): number | null {
  const normalized = normalize(value).toLowerCase();
  if (!normalized) {
    return null;
  }
  const index = [
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
  ].indexOf(normalized);
  return index >= 0 ? index + 1 : null;
}

function parseFuzzyMonthWindowText(text: string, reference: Date): ParsedTemporalWindow | null {
  const match = text.match(
    /\b(?:(early|mid(?:dle)?|late)\s*(?:to|-)\s*(early|mid(?:dle)?|late)|(early|mid(?:dle)?|late))\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\b/iu
  );
  if (!match) {
    return null;
  }
  const normalizedParts = [match[1], match[2], match[3]]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase().replace("middle", "mid"));
  const month = parseNamedMonth(match[4]);
  const year = match[5] ? Number(match[5]) : reference.getUTCFullYear();
  if (!month || !Number.isFinite(year)) {
    return null;
  }
  const monthDays = daysInMonth(year, month);
  let startDay = 1;
  let endDay = monthDays;
  for (const part of normalizedParts) {
    if (part === "early") {
      startDay = Math.max(startDay, 1);
      endDay = Math.min(endDay, 10);
    } else if (part === "mid") {
      startDay = Math.max(startDay, 11);
      endDay = Math.min(endDay, 20);
    } else if (part === "late") {
      startDay = Math.max(startDay, 21);
      endDay = monthDays;
    }
  }
  if (normalizedParts.length === 2 && normalizedParts.includes("mid") && normalizedParts.includes("late")) {
    startDay = 11;
    endDay = monthDays;
  }
  if (normalizedParts.length === 2 && normalizedParts.includes("early") && normalizedParts.includes("mid")) {
    startDay = 1;
    endDay = 20;
  }
  return {
    startAt: startOfDayUtc(year, month, startDay),
    endAt: endOfDayUtc(year, month, endDay),
    answerYear: year,
    answerMonth: month,
    answerDay: null,
    timeGranularity: "month",
    exactness: "bounded"
  };
}

function parseSeasonWindowText(text: string, reference: Date): ParsedTemporalWindow | null {
  const match = text.match(/\b(this|next|last)?\s*(spring|summer|fall|autumn|winter)(?:\s+(\d{4}))?\b/iu);
  if (!match) {
    return null;
  }
  let year = match[3] ? Number(match[3]) : reference.getUTCFullYear();
  const modifier = normalize(match[1]).toLowerCase();
  const season = normalize(match[2]).toLowerCase();
  if (!match[3]) {
    if (modifier === "next") {
      year += 1;
    } else if (modifier === "last") {
      year -= 1;
    }
  }
  if (!Number.isFinite(year)) {
    return null;
  }
  let startMonth = 3;
  let endMonth = 5;
  let endYear = year;
  if (season === "summer") {
    startMonth = 6;
    endMonth = 8;
  } else if (season === "fall" || season === "autumn") {
    startMonth = 9;
    endMonth = 11;
  } else if (season === "winter") {
    startMonth = 12;
    endMonth = 2;
    endYear = year + 1;
  }
  return {
    startAt: new Date(Date.UTC(year, startMonth - 1, 1, 0, 0, 0, 0)).toISOString(),
    endAt: endOfMonth(endYear, endMonth).toISOString(),
    answerYear: year,
    answerMonth: null,
    answerDay: null,
    timeGranularity: "season",
    exactness: "bounded"
  };
}

export function parseDurationText(text: string | null | undefined): ParsedDurationValue | null {
  const normalized = readString(text);
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  const monthAndHalf = lowered.match(/\b(?:about|around|roughly|approximately|for)?\s*(?:a|one)?\s*month\s+and\s+(?:a\s+)?half\b/u);
  if (monthAndHalf) {
    return {
      rawText: monthAndHalf[0],
      approximateSeconds: 45 * 24 * 60 * 60,
      normalizedUnit: "month",
      approximate: true
    };
  }
  const weekAndHalf = lowered.match(/\b(?:about|around|roughly|approximately|for)?\s*(?:a|one)?\s*week\s+and\s+(?:a\s+)?half\b/u);
  if (weekAndHalf) {
    return {
      rawText: weekAndHalf[0],
      approximateSeconds: Math.round(10.5 * 24 * 60 * 60),
      normalizedUnit: "week",
      approximate: true
    };
  }
  const simple = lowered.match(
    /\b(?:about|around|roughly|approximately|for)?\s*(an?|one|two|three|four|five|six|seven|eight|nine|ten|\d+(?:\.\d+)?)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/u
  );
  if (!simple) {
    return null;
  }
  const quantityToken = simple[1] ?? "";
  const quantityLookup: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };
  const quantity = quantityLookup[quantityToken] ?? Number(quantityToken);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  const unit = (simple[2] ?? "").toLowerCase();
  const normalizedUnit =
    unit.startsWith("minute") ? "minute" :
    unit.startsWith("hour") ? "hour" :
    unit.startsWith("day") ? "day" :
    unit.startsWith("week") ? "week" :
    unit.startsWith("month") ? "month" :
    "year";
  const secondsPerUnit: Record<ParsedDurationValue["normalizedUnit"], number> = {
    minute: 60,
    hour: 60 * 60,
    day: 24 * 60 * 60,
    week: 7 * 24 * 60 * 60,
    month: 30 * 24 * 60 * 60,
    year: 365 * 24 * 60 * 60
  };
  return {
    rawText: simple[0],
    approximateSeconds: Math.round(quantity * secondsPerUnit[normalizedUnit]),
    normalizedUnit,
    approximate: normalizedUnit === "month" || normalizedUnit === "year" || /\b(?:about|around|roughly|approximately)\b/u.test(lowered)
  };
}

export function parseTemporalWindowText(params: {
  readonly text: string | null | undefined;
  readonly referenceNow?: string | null;
  readonly fallbackStart?: string | null;
  readonly fallbackEnd?: string | null;
}): ParsedTemporalWindow | null {
  const text = readString(params.text);
  if (!text) {
    return null;
  }
  const reference = new Date(params.referenceNow ?? params.fallbackStart ?? params.fallbackEnd ?? Date.now());
  const fuzzyMonth = parseFuzzyMonthWindowText(text, reference);
  if (fuzzyMonth) {
    return fuzzyMonth;
  }
  const seasonWindow = parseSeasonWindowText(text, reference);
  if (seasonWindow) {
    return seasonWindow;
  }
  const parsed = chrono.parse(text, reference, { forwardDate: false })[0];
  if (!parsed) {
    return null;
  }
  const start = parsed.start.date();
  const end = parsed.end?.date() ?? null;
  const hasYear = parsed.start.isCertain("year");
  const hasMonth = parsed.start.isCertain("month");
  const hasDay = parsed.start.isCertain("day");
  const exactness: TemporalEventExactness = hasYear && hasMonth && hasDay ? "exact" : end ? "bounded" : "inferred";
  let timeGranularity: string | null = null;
  if (hasYear && hasMonth && hasDay) {
    timeGranularity = "day";
  } else if (hasYear && hasMonth) {
    timeGranularity = "month";
  } else if (hasYear) {
    timeGranularity = "year";
  }

  let startAt = toIso(start);
  let endAt = toIso(end);
  if (!endAt && hasYear && hasMonth && !hasDay) {
    endAt = toIso(endOfMonth(start.getUTCFullYear(), start.getUTCMonth() + 1));
  }
  if (!endAt && hasYear && !hasMonth) {
    endAt = toIso(endOfYear(start.getUTCFullYear()));
  }

  return {
    startAt,
    endAt,
    answerYear: hasYear ? start.getUTCFullYear() : null,
    answerMonth: hasYear && hasMonth ? start.getUTCMonth() + 1 : null,
    answerDay: hasYear && hasMonth && hasDay ? start.getUTCDate() : null,
    timeGranularity,
    exactness
  };
}

function parseFromCanonicalRow(row: CanonicalTemporalFactSourceRow): ParsedTemporalWindow {
  if (typeof row.answer_year === "number") {
    const month = row.answer_month ?? 1;
    const day = row.answer_day ?? 1;
    const exactness: TemporalEventExactness =
      typeof row.answer_day === "number" ? "exact" :
      typeof row.answer_month === "number" ? "bounded" :
      "inferred";
    const start = new Date(Date.UTC(row.answer_year, month - 1, day, 0, 0, 0, 0));
    const end =
      typeof row.answer_day === "number"
        ? new Date(Date.UTC(row.answer_year, month - 1, day, 23, 59, 59, 999))
        : typeof row.answer_month === "number"
          ? endOfMonth(row.answer_year, month)
          : endOfYear(row.answer_year);
    return {
      startAt: toIso(start),
      endAt: toIso(end),
      answerYear: row.answer_year,
      answerMonth: row.answer_month,
      answerDay: row.answer_day,
      timeGranularity: row.time_granularity ?? (row.answer_day ? "day" : row.answer_month ? "month" : "year"),
      exactness
    };
  }

  if (row.anchor_start || row.anchor_end) {
    const hasSameBoundary = row.anchor_start && row.anchor_end && row.anchor_start === row.anchor_end;
    const inferredDate = row.anchor_start ? new Date(row.anchor_start) : row.anchor_end ? new Date(row.anchor_end) : null;
    return {
      startAt: row.anchor_start,
      endAt: row.anchor_end ?? row.anchor_start,
      answerYear: inferredDate && Number.isFinite(inferredDate.getTime()) ? inferredDate.getUTCFullYear() : null,
      answerMonth:
        inferredDate && Number.isFinite(inferredDate.getTime()) && hasSameBoundary
          ? inferredDate.getUTCMonth() + 1
          : null,
      answerDay:
        inferredDate && Number.isFinite(inferredDate.getTime()) && hasSameBoundary
          ? inferredDate.getUTCDate()
          : null,
      timeGranularity: row.time_granularity,
      exactness: hasSameBoundary ? "exact" : "bounded"
    };
  }

  return (
    parseTemporalWindowText({
      text: row.fact_value ?? row.anchor_text,
      referenceNow: row.t_valid_from ?? row.t_valid_until ?? row.anchor_start ?? row.anchor_end
    }) ?? {
      startAt: row.t_valid_from,
      endAt: row.t_valid_until,
      answerYear: null,
      answerMonth: null,
      answerDay: null,
      timeGranularity: row.time_granularity,
      exactness: "inferred"
    }
  );
}

function snippetForSupport(row: CanonicalTemporalFactSourceRow): string {
  return (readString(row.fact_value) ?? readString(row.anchor_text) ?? normalize(row.event_key)) || "temporal support";
}

function inferEventObjectValue(row: CanonicalTemporalFactSourceRow): string | null {
  const family = inferExactDetailFamilyFromSource({
    predicateFamily: row.predicate_family,
    valueText: row.fact_value,
    eventKey: row.event_key,
    eventType: row.event_type,
    supportTexts: [row.anchor_text ?? ""],
    metadata: row.metadata
  });
  if (family) {
    const extracted = extractAtomicExactDetailValue({
      family,
      texts: [row.fact_value ?? "", row.anchor_text ?? ""]
    });
    if (extracted) {
      return extracted;
    }
  }
  return readString(row.fact_value) ?? readString(row.anchor_text) ?? null;
}

function inferEventSubjectRole(row: CanonicalTemporalFactSourceRow): string {
  return row.object_entity_id ? "subject_object" : "subject";
}

function inferVersionGroupKey(row: CanonicalTemporalFactSourceRow): string {
  return [
    normalizeKey(row.subject_entity_id),
    normalizeKey(row.event_key),
    normalizeKey(row.predicate_family),
    normalizeKey(row.event_type)
  ]
    .filter(Boolean)
    .join("::");
}

function inferConflictStatus(rows: readonly CanonicalTemporalFactSourceRow[], truthStatus: TemporalEventTruthStatus): string | null {
  if (truthStatus === "uncertain") {
    return "conflict";
  }
  const distinctValues = new Set(
    rows
      .map((row) => normalizeKey(inferEventObjectValue(row)))
      .filter(Boolean)
  );
  return distinctValues.size > 1 ? "conflict" : null;
}

function inferSourceTurnIds(rows: readonly CanonicalTemporalFactSourceRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const metadata = row.metadata ?? {};
    for (const key of ["source_turn_ids", "source_memory_ids"]) {
      for (const id of readUuidArray(metadata[key])) {
        ids.add(id);
      }
    }
    const singular = readString(metadata.source_memory_id);
    if (singular) {
      ids.add(singular);
    }
  }
  return [...ids];
}

function truthStatusForRows(rows: readonly CanonicalTemporalFactSourceRow[]): TemporalEventTruthStatus {
  const activeRows = rows.filter((row) => row.t_valid_until === null);
  const exactDayKeys = new Set(
    activeRows
      .map((row) => parseFromCanonicalRow(row))
      .filter((parsed) => parsed.answerYear && parsed.answerMonth && parsed.answerDay)
      .map((parsed) => `${parsed.answerYear}-${parsed.answerMonth}-${parsed.answerDay}`)
  );
  if (exactDayKeys.size > 1) {
    return "uncertain";
  }
  if (activeRows.length > 0) {
    return "active";
  }
  return rows.length > 0 ? "superseded" : "uncertain";
}

async function deleteTemporalEventRows(client: PoolClient, namespaceId: string): Promise<void> {
  await client.query("DELETE FROM temporal_event_support WHERE namespace_id = $1", [namespaceId]);
  await client.query("DELETE FROM temporal_event_facts WHERE namespace_id = $1", [namespaceId]);
}

export async function rebuildTemporalEventFactsNamespaceForClient(
  client: PoolClient,
  namespaceId: string
): Promise<TemporalEventRebuildSummary> {
  await deleteTemporalEventRows(client, namespaceId);
  const rows = await client.query<CanonicalTemporalFactSourceRow>(
    `
      SELECT
        id::text,
        namespace_id,
        subject_entity_id::text,
        object_entity_id::text,
        predicate_family,
        event_key,
        event_type,
        fact_value,
        anchor_text,
        anchor_start::text,
        anchor_end::text,
        t_valid_from::text,
        t_valid_until::text,
        time_granularity,
        answer_year,
        answer_month,
        answer_day,
        confidence,
        support_kind,
        temporal_source_quality,
        source_artifact_id::text,
        source_chunk_id::text,
        metadata
      FROM canonical_temporal_facts
      WHERE namespace_id = $1
        AND subject_entity_id IS NOT NULL
        AND event_key IS NOT NULL
      ORDER BY subject_entity_id ASC, event_key ASC, confidence DESC NULLS LAST, t_valid_from DESC NULLS LAST, created_at DESC
    `,
    [namespaceId]
  );

  const grouped = new Map<string, CanonicalTemporalFactSourceRow[]>();
  for (const row of rows.rows) {
    const key = `${row.subject_entity_id ?? "unknown"}::${normalizeKey(row.event_key)}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  let facts = 0;
  let supports = 0;
  for (const groupRows of grouped.values()) {
    const selected = [...groupRows].sort((left, right) =>
      (right.confidence ?? 0) - (left.confidence ?? 0) ||
      Date.parse(right.t_valid_from ?? right.anchor_start ?? right.anchor_end ?? "1970-01-01T00:00:00.000Z") -
        Date.parse(left.t_valid_from ?? left.anchor_start ?? left.anchor_end ?? "1970-01-01T00:00:00.000Z")
    )[0];
    if (!selected?.subject_entity_id || !selected.event_key) {
      continue;
    }
    const parsed = parseFromCanonicalRow(selected);
    const truthStatus = truthStatusForRows(groupRows);
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO temporal_event_facts (
          namespace_id,
          contract_name,
          subject_entity_id,
          pair_subject_entity_id,
          event_key,
          event_label,
          event_type,
          predicate_family,
          object_entity_id,
          object_value,
          event_subject_role,
          version_group_key,
          recorded_at,
          conflict_status,
          source_turn_ids,
          start_at,
          end_at,
          answer_year,
          answer_month,
          answer_day,
          time_granularity,
          exactness,
          valid_from,
          valid_until,
          truth_status,
          support_count,
          metadata
        )
        VALUES (
          $1, 'temporal_event_bundle', $2::uuid, NULL::uuid, $3, $4, $5,
          $6, $7::uuid, $8, $9, $10, $11::timestamptz, $12, $13::uuid[],
          $14::timestamptz, $15::timestamptz, $16, $17, $18, $19, $20, $21::timestamptz, $22::timestamptz, $23, $24, $25::jsonb
        )
        RETURNING id::text
      `,
      [
        namespaceId,
        selected.subject_entity_id,
        selected.event_key,
        readString(selected.fact_value) ?? readString(selected.anchor_text) ?? selected.event_key.replaceAll("_", " "),
        selected.event_type,
        selected.predicate_family,
        selected.object_entity_id,
        inferEventObjectValue(selected),
        inferEventSubjectRole(selected),
        inferVersionGroupKey(selected),
        selected.t_valid_from ?? selected.anchor_start ?? selected.anchor_end,
        inferConflictStatus(groupRows, truthStatus),
        inferSourceTurnIds(groupRows),
        parsed.startAt,
        parsed.endAt,
        parsed.answerYear,
        parsed.answerMonth,
        parsed.answerDay,
        parsed.timeGranularity,
        parsed.exactness,
        minIso(groupRows.map((row) => row.t_valid_from ?? row.anchor_start)),
        groupRows.some((row) => row.t_valid_until === null) ? null : maxIso(groupRows.map((row) => row.t_valid_until ?? row.anchor_end)),
        truthStatus,
        groupRows.length,
        jsonString({
          predicate_family: selected.predicate_family,
          object_entity_id: selected.object_entity_id,
          object_value: inferEventObjectValue(selected),
          source_temporal_fact_ids: groupRows.map((row) => row.id),
          source_qualities: groupRows.map((row) => row.temporal_source_quality).filter(Boolean),
          support_kinds: groupRows.map((row) => row.support_kind).filter(Boolean)
        })
      ]
    );
    const temporalEventFactId = result.rows[0]?.id;
    if (!temporalEventFactId) {
      throw new Error(`Failed to insert temporal_event_fact for ${selected.event_key}.`);
    }
    facts += 1;
    for (const row of groupRows) {
      await client.query(
        `
          INSERT INTO temporal_event_support (
            namespace_id,
            temporal_event_fact_id,
            support_table,
            source_row_id,
            support_memory_id,
            support_role,
            snippet,
            occurred_at,
            metadata
          )
          VALUES ($1, $2::uuid, 'canonical_temporal_facts', $3::uuid, NULL::uuid, $4, $5, $6::timestamptz, $7::jsonb)
        `,
        [
          namespaceId,
          temporalEventFactId,
          row.id,
          truthStatus === "uncertain" ? "conflict" : row.id === selected.id ? "primary" : "support",
          snippetForSupport(row),
          row.t_valid_from ?? row.anchor_start ?? row.anchor_end,
          jsonString({
            event_type: row.event_type,
            support_kind: row.support_kind,
            source_artifact_id: row.source_artifact_id,
            source_chunk_id: row.source_chunk_id,
            raw_metadata: row.metadata ?? {}
          })
        ]
      );
      supports += 1;
    }
  }

  return { namespaceId, facts, supports };
}

export async function rebuildTemporalEventFactsNamespace(namespaceId: string): Promise<TemporalEventRebuildSummary> {
  return withTransaction((client) => rebuildTemporalEventFactsNamespaceForClient(client, namespaceId));
}

export async function loadTemporalEventFacts(namespaceId: string): Promise<readonly TemporalEventFact[]> {
  return queryRows<{
    readonly id: string;
    readonly namespace_id: string;
    readonly contract_name: string;
    readonly subject_entity_id: string | null;
    readonly pair_subject_entity_id: string | null;
    readonly event_key: string;
    readonly event_label: string | null;
    readonly event_type: string | null;
    readonly start_at: string | null;
    readonly end_at: string | null;
    readonly answer_year: number | null;
    readonly answer_month: number | null;
    readonly answer_day: number | null;
    readonly time_granularity: string | null;
    readonly exactness: TemporalEventExactness;
    readonly valid_from: string | null;
    readonly valid_until: string | null;
    readonly truth_status: TemporalEventTruthStatus;
    readonly support_count: number;
    readonly metadata: JsonRecord;
  }>(
    `
      SELECT
        id::text,
        namespace_id,
        contract_name,
        subject_entity_id::text,
        pair_subject_entity_id::text,
        event_key,
        event_label,
        event_type,
        start_at::text,
        end_at::text,
        answer_year,
        answer_month,
        answer_day,
        time_granularity,
        exactness,
        valid_from::text,
        valid_until::text,
        truth_status,
        support_count,
        metadata
      FROM temporal_event_facts
      WHERE namespace_id = $1
      ORDER BY subject_entity_id ASC NULLS LAST, event_key ASC
    `,
    [namespaceId]
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      namespaceId: row.namespace_id,
      contractName: row.contract_name,
      subjectEntityId: row.subject_entity_id,
      pairSubjectEntityId: row.pair_subject_entity_id,
      eventKey: row.event_key,
      eventLabel: row.event_label,
      eventType: row.event_type,
      startAt: row.start_at,
      endAt: row.end_at,
      answerYear: row.answer_year,
      answerMonth: row.answer_month,
      answerDay: row.answer_day,
      timeGranularity: row.time_granularity,
      exactness: row.exactness,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      truthStatus: row.truth_status,
      supportCount: row.support_count,
      metadata: row.metadata
    }))
  );
}

export async function loadTemporalEventSupport(
  temporalEventFactId: string
): Promise<readonly TemporalEventSupport[]> {
  return queryRows<{
    readonly id: string;
    readonly temporal_event_fact_id: string;
    readonly support_table: string;
    readonly source_row_id: string | null;
    readonly support_memory_id: string | null;
    readonly support_role: "primary" | "support" | "conflict";
    readonly snippet: string | null;
    readonly occurred_at: string | null;
    readonly metadata: JsonRecord;
  }>(
    `
      SELECT
        id::text,
        temporal_event_fact_id::text,
        support_table,
        source_row_id::text,
        support_memory_id::text,
        support_role,
        snippet,
        occurred_at::text,
        metadata
      FROM temporal_event_support
      WHERE temporal_event_fact_id = $1::uuid
      ORDER BY
        CASE support_role WHEN 'primary' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
        occurred_at DESC NULLS LAST,
        id ASC
    `,
    [temporalEventFactId]
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      temporalEventFactId: row.temporal_event_fact_id,
      supportTable: row.support_table,
      sourceRowId: row.source_row_id,
      supportMemoryId: row.support_memory_id,
      supportRole: row.support_role,
      snippet: row.snippet,
      occurredAt: row.occurred_at,
      metadata: row.metadata
    }))
  );
}
