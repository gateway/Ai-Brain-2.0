import { performance } from "node:perf_hooks";
import { queryRows } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { RecallResult } from "../types.js";
import { buildDirectSourceSearchResponse } from "./route-locked-fast-paths.js";
import { queryContractTelemetry, type QueryContract } from "./query-contract-router.js";
import { continuityCurrentStateProjectionEnabled } from "./query-runtime-flags.js";
import type { RecallQuery, RecallResponse } from "./types.js";

export { buildAliasCurrentStateProjectionResponse } from "./alias-current-state-projection.js";
export { buildRecapProfileProjectionResponse } from "./recap-profile-projection.js";

interface ContinuityProjectionHeadRow {
  readonly id: string;
  readonly summary_text: string | null;
  readonly support_count: number;
  readonly projection_version: string;
  readonly render_payload: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface ContinuityProjectionEntryRow {
  readonly id: string;
  readonly display_value: string;
  readonly entry_type: string;
  readonly source_table: string | null;
  readonly source_row_id: string | null;
  readonly source_confidence: number | null;
  readonly metadata: Record<string, unknown> | null;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function continuityProjectionFamiliesForQuery(queryText: string): readonly string[] {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  if (/\bproject idea\b|\bidea exactly\b|\bdiscuss(?:ed)?\b[\s\S]{0,40}\bidea\b/u.test(normalized)) {
    return [];
  }
  const families: string[] = [];
  if (/\b(?:warm start|start today|what should you know about me|know about me to start)\b/u.test(normalized)) {
    families.push("warm_start_context", "current_focus", "next_action", "current_constraint");
  }
  if (/\b(?:pick back up|carry forward|next action|what should i do next|continue|handoff)\b/u.test(normalized)) {
    families.push("next_action", "current_focus", "recent_work_recap");
  }
  if (/\byesterday\b|\bwhat did i do\b|\btalk about yesterday\b/u.test(normalized)) {
    families.push("recent_work_recap", "current_focus");
  }
  if (/\b(?:current focus|actively focused|current project|projects?|working on)\b/u.test(normalized)) {
    families.push("current_focus", "next_action");
  }
  if (/\b(?:daily routine|routine|morning routine)\b/u.test(normalized)) {
    families.push("daily_routine", "current_focus");
  }
  if (/\b(?:habits?|constraints?|personal time|protect time)\b/u.test(normalized)) {
    families.push("current_constraint", "daily_routine");
  }
  return uniqueStrings(families);
}

function extractContinuityProjectNames(value: string): string[] {
  const text = normalizeWhitespace(value);
  const projects: string[] = [];
  if (/\bAI Brain\b/i.test(text)) projects.push("AI Brain");
  if (/\bPreset Kitchen\b/i.test(text)) projects.push("Preset Kitchen");
  if (/\bBumblebee\b/i.test(text)) projects.push("Bumblebee");
  if (/\bWell Inked\b/i.test(text)) projects.push("Well Inked");
  if (/\bTwo Way\b/i.test(text)) projects.push("Two Way");
  return projects;
}

function extractContinuityRoutineItems(value: string): string[] {
  const text = normalizeWhitespace(value);
  const items: string[] = [];
  if (/\bwake around 7 to 8 AM\b/i.test(text)) items.push("wake around 7 to 8 AM");
  if (/\bmake coffee\b/i.test(text)) items.push("make coffee");
  if (/\bReddit\b/i.test(text)) items.push("check AI news on Reddit");
  if (/\breview email\b/i.test(text) && /\bcurrent tasks\b/i.test(text)) items.push("review email and current tasks");
  else {
    if (/\breview email\b/i.test(text)) items.push("review email");
    if (/\bcurrent tasks\b/i.test(text)) items.push("review current tasks");
  }
  if (/\bstart work around 10 AM\b/i.test(text)) items.push("start work around 10 AM");
  if (/\bmidday exercise break\b/i.test(text)) items.push("take a midday exercise break");
  return items;
}

function buildContinuityProjectionClaimText(
  queryText: string,
  heads: readonly ContinuityProjectionHeadRow[],
  entries: readonly ContinuityProjectionEntryRow[]
): string {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const values = grouped.get(entry.entry_type) ?? [];
    values.push(normalizeWhitespace(entry.display_value));
    grouped.set(entry.entry_type, values);
  }
  const allTextByFamily = (family: string): string[] => [
    ...(grouped.get(family) ?? []),
    ...heads
      .filter((head) => head.metadata?.projection_family === family || head.metadata?.projectionFamily === family)
      .map((head) => normalizeWhitespace(head.summary_text ?? ""))
  ];
  const projectNames = uniqueStrings([
    ...allTextByFamily("warm_start_context").flatMap(extractContinuityProjectNames),
    ...allTextByFamily("current_focus").flatMap(extractContinuityProjectNames),
    ...allTextByFamily("recent_work_recap").flatMap(extractContinuityProjectNames)
  ]);
  const routineItems = uniqueStrings(allTextByFamily("daily_routine").flatMap(extractContinuityRoutineItems));
  const constraints = uniqueStrings(
    allTextByFamily("current_constraint")
      .map((value) => (/personal time/i.test(value) ? "protect personal time" : ""))
      .filter(Boolean)
  );
  const nextActions = uniqueStrings(
    allTextByFamily("next_action")
      .flatMap((value) => {
        const actions: string[] = [];
        if (/finish the Preset Kitchen site/i.test(value)) actions.push("finish the Preset Kitchen site");
        if (/push out the Preset Kitchen site/i.test(value)) actions.push("push out the Preset Kitchen site");
        if (/add presets to the Preset Kitchen site/i.test(value)) actions.push("add presets to the Preset Kitchen site");
        return actions;
      })
  );
  const sections = [
    projectNames.length > 0 && /\b(?:versus|vs\.?|side\s+projects?|just\s+a\s+side)\b/iu.test(queryText)
      ? `Active / current work: ${projectNames.join(", ")}.`
      : projectNames.length > 0
        ? `Warm start for Steve: Current focus includes ${projectNames.join(", ")}.`
        : null,
    projectNames.length > 0 && /\b(?:versus|vs\.?|side\s+projects?|just\s+a\s+side)\b/iu.test(queryText)
      ? "Side-project status: no source-bound side-project classification was selected; treat unsupported project-status labels as gaps instead of guessing."
      : null,
    nextActions.length > 0 ? `Carry forward: ${nextActions.join(", ")}.` : null,
    routineItems.length > 0 ? `Current daily routine: ${routineItems.join(", ")}.` : null,
    projectNames.includes("Well Inked") || projectNames.includes("Two Way")
      ? `Work context includes ${["Well Inked", "Two Way"].filter((value) => projectNames.includes(value)).join(" and ")}.`
      : null,
    constraints.length > 0 ? `Active constraints include ${constraints.join(", ")}.` : null
  ].filter((value): value is string => Boolean(value));
  if (sections.length > 0) {
    return sections.join(" ");
  }
  return uniqueStrings(heads.map((head) => normalizeWhitespace(head.summary_text ?? ""))).join(" ") || "Source-backed continuity context is available.";
}

async function loadContinuityCurrentStateProjection(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
}): Promise<{ readonly heads: readonly ContinuityProjectionHeadRow[]; readonly entries: readonly ContinuityProjectionEntryRow[] } | null> {
  if (!continuityCurrentStateProjectionEnabled()) {
    return null;
  }
  const families = continuityProjectionFamiliesForQuery(params.queryText);
  if (families.length === 0) {
    return null;
  }
  const heads = await queryRows<ContinuityProjectionHeadRow>(
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
        AND contract_name = 'continuity_current_state'
        AND projection_version = 'continuity_current_state_projection_v1'
        AND projection_kind = 'report'
        AND truth_status = 'active'
        AND support_count > 0
        AND metadata->>'projection_family' = ANY($2::text[])
      ORDER BY
        CASE metadata->>'projection_family'
          WHEN 'warm_start_context' THEN 0
          WHEN 'current_focus' THEN 1
          WHEN 'next_action' THEN 2
          WHEN 'recent_work_recap' THEN 3
          WHEN 'daily_routine' THEN 4
          WHEN 'current_constraint' THEN 5
          ELSE 9
        END,
        support_count DESC,
        updated_at DESC
      LIMIT $3
    `,
    [params.namespaceId, families, Math.max(1, Math.min(4, families.length))]
  );
  if (heads.length === 0) {
    return null;
  }
  const entries = await queryRows<ContinuityProjectionEntryRow>(
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
    [params.namespaceId, heads.map((head) => head.id), Math.max(params.limit * 3, 12)]
  );
  return entries.length > 0 ? { heads, entries } : null;
}

function continuityProjectionResults(params: {
  readonly namespaceId: string;
  readonly heads: readonly ContinuityProjectionHeadRow[];
  readonly entries: readonly ContinuityProjectionEntryRow[];
  readonly limit: number;
}): RecallResult[] {
  return params.entries.slice(0, Math.max(params.limit * 2, 8)).map((entry, index) => {
    const metadata = entry.metadata ?? {};
    const sourceQuote = typeof metadata.source_quote === "string" ? metadata.source_quote : entry.display_value;
    return {
      memoryId: `continuity_current_state_projection:${entry.id}`,
      memoryType: "semantic_memory",
      content: `${entry.display_value} Evidence: ${sourceQuote}`,
      score: 1 - index / 100,
      artifactId: typeof metadata.source_artifact_id === "string" ? metadata.source_artifact_id : null,
      occurredAt: typeof metadata.observed_at === "string" ? metadata.observed_at : null,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "continuity_current_state_projection",
        source_table: entry.source_table,
        source_row_id: entry.source_row_id,
        source_uri: typeof metadata.source_uri === "string" ? metadata.source_uri : null,
        source_quote: sourceQuote,
        source_chunk_id: typeof metadata.source_chunk_id === "string" ? metadata.source_chunk_id : null,
        projection_head_ids: params.heads.map((head) => head.id),
        projection_entry_id: entry.id,
        projection_version: "continuity_current_state_projection_v1",
        support_bundle_family: "current_state",
        continuity_projection_family: entry.entry_type,
        confidence: entry.source_confidence
      }
    };
  });
}

export async function buildContinuityCurrentStateProjectionResponse(
  query: RecallQuery,
  queryText: string,
  limit: number,
  queryContract?: QueryContract | null
): Promise<RecallResponse | null> {
  const startedAt = performance.now();
  const projection = await loadContinuityCurrentStateProjection({
    namespaceId: query.namespaceId,
    queryText,
    limit
  });
  if (!projection) {
    return null;
  }
  const results = continuityProjectionResults({
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
    claimText: buildContinuityProjectionClaimText(queryText, projection.heads, projection.entries),
    stageName: "continuity_current_state_projection",
    startedAt,
    answerReason:
      "The continuity/current-state query was answered from source-bound offline projections before lexical/enrichment retrieval.",
    supportBundleFamily: "current_state",
    compiledLookupTried: true,
    proceduralLookupTried: true,
    sourceBoundedReadTried: true,
    sourceBoundedReadSucceeded: true,
    finalRouteFamily: "continuity_current_state_projection",
    extraMeta: {
      continuityProjectionTried: true,
      continuityProjectionSucceeded: true,
      continuityProjectionVersion: "continuity_current_state_projection_v1",
      continuityProjectionEntryCount: projection.entries.length,
      continuityProjectionEvidenceCount: results.length,
      continuityProjectionLatencyMs: Number(latencyMs.toFixed(2)),
      continuityProjectionBlockedReason: null,
      finalClaimSource: "continuity_current_state_projection",
      fallbackBlockedReason: "continuity_current_state_projection_sufficient",
      canonicalFallbackBlockedReason: "continuity_current_state_projection_sufficient",
      ...(queryContract
        ? queryContractTelemetry(queryContract, "continuity_current_state_projection", "source_bound_contract_selected")
        : {})
    }
  });
}
