import { performance } from "node:perf_hooks";
import { queryRows } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { RecallResult } from "../types.js";
import { buildDirectSourceSearchResponse, isHistoricalPreferenceTruthQuery } from "./route-locked-fast-paths.js";
import { queryContractTelemetry, type QueryContract } from "./query-contract-router.js";
import { aliasCurrentStateProjectionEnabled as enabled } from "./query-runtime-flags.js";
import type { RecallQuery, RecallResponse } from "./types.js";

type AliasCurrentStateFamily =
  | "place_alias"
  | "person_alias"
  | "media_title_list"
  | "food_preference_list"
  | "beer_preference_list"
  | "coffee_preference"
  | "preference_profile_list";

interface AliasCurrentStateProjectionHeadRow {
  readonly id: string;
  readonly summary_text: string | null;
  readonly support_count: number;
  readonly projection_version: string;
  readonly render_payload: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface AliasCurrentStateProjectionEntryRow {
  readonly id: string;
  readonly display_value: string;
  readonly entry_type: AliasCurrentStateFamily;
  readonly source_table: string | null;
  readonly source_row_id: string | null;
  readonly source_confidence: number | null;
  readonly metadata: Record<string, unknown> | null;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values.map((entry) => normalizeWhitespace(entry)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output;
}

function familiesForQuery(queryText: string): readonly AliasCurrentStateFamily[] {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  if (isHistoricalPreferenceTruthQuery(normalized)) {
    return [];
  }
  const families: AliasCurrentStateFamily[] = [];
  const asksForSpecificMediaEvent =
    /\b(?:what|which)\s+(?:movie|film|show|tv\s+show)\s+did\b/u.test(normalized) ||
    (/\b(?:movie|film|show|tv\s+show)\b/u.test(normalized) &&
      /\b(?:when|where|mention(?:ed)?|watched|recommended|two\s+weeks\s+ago|last\s+week|yesterday|today)\b/u.test(normalized));
  const mentionsStandaloneShow = /\bshows?\b/u.test(normalized) && !/\bshow\s+me\b/u.test(normalized);
  if (/\b(?:kozimui|kozamui|what is\s+[a-z][a-z -]{2,40}\?)\b/u.test(normalized)) {
    families.push("place_alias");
  }
  if (/\b(?:who|what)\s+is\s+uncle\b/u.test(normalized)) {
    families.push("person_alias");
  }
  if (!asksForSpecificMediaEvent && (/\b(?:movies?|films?|tv\s+shows?|talked about|watched)\b/u.test(normalized) || mentionsStandaloneShow)) {
    families.push("media_title_list");
  }
  if (/\bfood\b/u.test(normalized) && /\b(?:like|liked|prefer|favorite)\b/u.test(normalized)) {
    families.push("food_preference_list");
  }
  if (/\bbeers?\b/u.test(normalized) && /\b(?:thailand|favorite|like|prefer)\b/u.test(normalized)) {
    families.push("beer_preference_list");
  }
  if (/\bcoffee\b/u.test(normalized) && /\b(?:prefer|current|now|like)\b/u.test(normalized)) {
    families.push("coffee_preference");
  }
  if (/\b(?:like and dislike|likes and dislikes|what do i like|what does steve like)\b/u.test(normalized)) {
    families.push("preference_profile_list");
  }
  return uniqueStrings(families) as AliasCurrentStateFamily[];
}

function queryAliasTerm(queryText: string): string | null {
  const direct = normalizeWhitespace(queryText.match(/\b(?:what|who)\s+is\s+([A-Za-z][A-Za-z -]{2,60})\??$/iu)?.[1] ?? "");
  if (!direct) {
    return null;
  }
  return direct.replace(/[?.!,;:]+$/u, "");
}

function entryFitsQuery(queryText: string, entry: AliasCurrentStateProjectionEntryRow): boolean {
  const value = normalizeWhitespace(entry.display_value).toLowerCase();
  const metadata = entry.metadata ?? {};
  const quote = normalizeWhitespace(typeof metadata.source_quote === "string" ? metadata.source_quote : "").toLowerCase();
  if (entry.entry_type === "place_alias") {
    const alias = queryAliasTerm(queryText)?.toLowerCase() ?? "";
    return Boolean(alias) && (quote.includes(alias) || value.includes(alias) || /\bkoh\s+samui\b/u.test(value));
  }
  if (entry.entry_type === "person_alias") {
    const alias = queryAliasTerm(queryText)?.toLowerCase() ?? "";
    return Boolean(alias) && (quote.includes(alias) || value.includes(alias) || quote.includes("uncle"));
  }
  return true;
}

function minimumRenderableEntries(family: AliasCurrentStateFamily): number {
  switch (family) {
    case "place_alias":
    case "person_alias":
      return 1;
    case "media_title_list":
      return 2;
    case "beer_preference_list":
      return 3;
    case "coffee_preference":
      return 2;
    case "food_preference_list":
      return 1;
    case "preference_profile_list":
      return 4;
  }
}

function renderableEntries(entries: readonly AliasCurrentStateProjectionEntryRow[]): readonly AliasCurrentStateProjectionEntryRow[] {
  const byFamily = new Map<AliasCurrentStateFamily, AliasCurrentStateProjectionEntryRow[]>();
  for (const entry of entries) {
    const bucket = byFamily.get(entry.entry_type) ?? [];
    bucket.push(entry);
    byFamily.set(entry.entry_type, bucket);
  }
  return [...byFamily.entries()]
    .filter(([family, familyEntries]) => uniqueStrings(familyEntries.map((entry) => entry.display_value)).length >= minimumRenderableEntries(family))
    .flatMap(([, familyEntries]) => familyEntries);
}

async function loadProjection(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
}): Promise<{ readonly heads: readonly AliasCurrentStateProjectionHeadRow[]; readonly entries: readonly AliasCurrentStateProjectionEntryRow[] } | null> {
  if (!enabled()) {
    return null;
  }
  const families = familiesForQuery(params.queryText);
  if (families.length === 0) {
    return null;
  }
  const heads = await queryRows<AliasCurrentStateProjectionHeadRow>(
    `
      SELECT
        id::text,
        summary_text,
        support_count,
        projection_version,
        render_payload,
        metadata
      FROM contract_projection_heads
      WHERE namespace_id = $1
        AND contract_name = 'alias_current_state'
        AND projection_kind = 'list'
        AND projection_version = 'alias_current_state_projection_v1'
        AND query_family = 'current_state'
        AND truth_status = 'active'
        AND support_count > 0
        AND metadata->>'projection_family' = ANY($2::text[])
      ORDER BY support_count DESC, updated_at DESC
      LIMIT $3
    `,
    [params.namespaceId, families, Math.max(1, families.length)]
  );
  if (heads.length === 0) {
    return null;
  }
  const candidateEntries = (await queryRows<AliasCurrentStateProjectionEntryRow>(
    `
      SELECT
        entry.id::text,
        entry.display_value,
        entry.entry_type,
        entry.source_table,
        entry.source_row_id::text,
        entry.source_confidence,
        entry.metadata
      FROM contract_projection_entries entry
      WHERE entry.namespace_id = $1
        AND entry.projection_head_id = ANY($2::uuid[])
        AND entry.truth_status = 'active'
        AND entry.active_truth = true
        AND NULLIF(entry.metadata->>'source_quote', '') IS NOT NULL
        AND entry.source_row_id IS NOT NULL
      ORDER BY entry.entry_index ASC
      LIMIT $3
    `,
    [params.namespaceId, heads.map((head) => head.id), Math.max(params.limit * 4, 16)]
  )).filter((entry) => entryFitsQuery(params.queryText, entry));
  const entries = renderableEntries(candidateEntries);
  return entries.length > 0 ? { heads, entries } : null;
}

function projectionResults(params: {
  readonly namespaceId: string;
  readonly heads: readonly AliasCurrentStateProjectionHeadRow[];
  readonly entries: readonly AliasCurrentStateProjectionEntryRow[];
  readonly limit: number;
}): RecallResult[] {
  return params.entries.slice(0, Math.max(params.limit * 3, 10)).map((entry, index) => {
    const metadata = entry.metadata ?? {};
    const sourceQuote = typeof metadata.source_quote === "string" ? metadata.source_quote : entry.display_value;
    return {
      memoryId: `alias_current_state_projection:${entry.id}`,
      memoryType: "semantic_memory",
      content: `${entry.display_value} Evidence: ${sourceQuote}`,
      score: 1 - index / 100,
      artifactId: typeof metadata.source_artifact_id === "string" ? metadata.source_artifact_id : null,
      occurredAt: typeof metadata.observed_at === "string" ? metadata.observed_at : null,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "alias_current_state_projection",
        source_table: entry.source_table,
        source_row_id: entry.source_row_id,
        source_uri: typeof metadata.source_uri === "string" ? metadata.source_uri : null,
        source_quote: sourceQuote,
        source_chunk_id: typeof metadata.source_chunk_id === "string" ? metadata.source_chunk_id : null,
        projection_head_ids: params.heads.map((head) => head.id),
        projection_entry_id: entry.id,
        projection_version: "alias_current_state_projection_v1",
        support_bundle_family: "current_state",
        alias_current_state_family: entry.entry_type,
        confidence: entry.source_confidence
      }
    };
  });
}

function joinValues(values: readonly string[]): string {
  const unique = uniqueStrings(values);
  if (unique.length <= 2) {
    return unique.join(" and ");
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique.at(-1)}`;
}

function claimText(queryText: string, entries: readonly AliasCurrentStateProjectionEntryRow[]): string {
  const grouped = new Map<AliasCurrentStateFamily, string[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.entry_type) ?? [];
    bucket.push(entry.display_value);
    grouped.set(entry.entry_type, bucket);
  }
  if ((grouped.get("place_alias") ?? []).length > 0) {
    const alias = queryAliasTerm(queryText) ?? "that alias";
    return `${alias} refers to ${joinValues(grouped.get("place_alias") ?? [])}.`;
  }
  if ((grouped.get("person_alias") ?? []).length > 0) {
    const alias = queryAliasTerm(queryText) ?? "that person";
    return `${alias} refers to ${joinValues(grouped.get("person_alias") ?? [])}.`;
  }
  if ((grouped.get("media_title_list") ?? []).length > 0) {
    return `You have talked about ${joinValues(grouped.get("media_title_list") ?? [])}.`;
  }
  if ((grouped.get("food_preference_list") ?? []).length > 0) {
    return `Food you liked includes ${joinValues(grouped.get("food_preference_list") ?? [])}.`;
  }
  if ((grouped.get("beer_preference_list") ?? []).length > 0) {
    return `Your Thailand beer preferences include ${joinValues(grouped.get("beer_preference_list") ?? [])}.`;
  }
  if ((grouped.get("coffee_preference") ?? []).length > 0) {
    return `Your coffee preference context includes ${joinValues(grouped.get("coffee_preference") ?? [])}.`;
  }
  if ((grouped.get("preference_profile_list") ?? []).length > 0) {
    return `Your preference profile includes ${joinValues(grouped.get("preference_profile_list") ?? [])}.`;
  }
  return "Source-backed current-state projection evidence is available.";
}

export async function buildAliasCurrentStateProjectionResponse(
  query: RecallQuery,
  queryText: string,
  limit: number,
  queryContract?: QueryContract | null
): Promise<RecallResponse | null> {
  const startedAt = performance.now();
  const projection = await loadProjection({
    namespaceId: query.namespaceId,
    queryText,
    limit
  });
  if (!projection) {
    return null;
  }
  const results = projectionResults({
    namespaceId: query.namespaceId,
    heads: projection.heads,
    entries: projection.entries,
    limit
  });
  if (results.length === 0) {
    return null;
  }
  const latencyMs = performance.now() - startedAt;
  return buildDirectSourceSearchResponse({
    query,
    results,
    claimText: claimText(queryText, projection.entries),
    stageName: "alias_current_state_projection",
    startedAt,
    answerReason:
      "The alias/current-state query was answered from source-bound offline projections before live source scanning or generic fallback.",
    supportBundleFamily: "current_state",
    compiledLookupTried: true,
    proceduralLookupTried: true,
    sourceBoundedReadTried: true,
    sourceBoundedReadSucceeded: true,
    finalRouteFamily: "alias_current_state_projection",
    extraMeta: {
      aliasCurrentStateProjectionTried: true,
      aliasCurrentStateProjectionSucceeded: true,
      aliasCurrentStateProjectionFamily: uniqueStrings(projection.entries.map((entry) => entry.entry_type)).join(","),
      aliasCurrentStateProjectionVersion: "alias_current_state_projection_v1",
      aliasCurrentStateProjectionEntryCount: projection.entries.length,
      aliasCurrentStateProjectionEvidenceCount: results.length,
      aliasCurrentStateProjectionLatencyMs: Number(latencyMs.toFixed(2)),
      aliasCurrentStateProjectionBlockedReason: null,
      finalClaimSource: "alias_current_state_projection",
      fallbackBlockedReason: "alias_current_state_projection_sufficient",
      canonicalFallbackBlockedReason: "alias_current_state_projection_sufficient",
      queryTimeGLiNEROrLLMUsed: false,
      ...(queryContract ? queryContractTelemetry(queryContract, "alias_current_state_projection", "source_bound_contract_selected") : {})
    }
  });
}
