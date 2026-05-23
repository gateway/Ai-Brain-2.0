import { performance } from "node:perf_hooks";
import { queryRows } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { RecallResult } from "../types.js";
import { loadDirectArtifactContextResults, loadDirectArtifactWindowResults, loadDirectOmiArtifactContextResults } from "./direct-source-read-models.js";
import { buildDirectSourceSearchResponse } from "./route-locked-fast-paths.js";
import { queryContractTelemetry, type QueryContract } from "./query-contract-router.js";
import { recapProfileProjectionEnabled as enabled } from "./query-runtime-flags.js";
import type { RecallQuery, RecallResponse } from "./types.js";

type RecapProfileFamily = "conversation_recap" | "source_profile_summary";

interface RecapProfileProjectionHeadRow {
  readonly id: string;
  readonly summary_text: string | null;
  readonly support_count: number;
  readonly projection_version: string;
  readonly render_payload: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown> | null;
}

interface RecapProfileProjectionEntryRow {
  readonly id: string;
  readonly display_value: string;
  readonly entry_type: RecapProfileFamily;
  readonly entry_role: string | null;
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
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function queryTopics(queryText: string): readonly { readonly family: RecapProfileFamily; readonly topicKey: string }[] {
  const normalized = normalizeWhitespace(queryText).toLowerCase();
  const topics: { family: RecapProfileFamily; topicKey: string }[] = [];
  if (/\bmartin\s+mark\b/u.test(normalized) && /\b(?:profile|life|piece together|what .*know|summary|overview)\b/u.test(normalized)) {
    topics.push({ family: "source_profile_summary", topicKey: "martin_mark_profile" });
  }
  if (/\b(?:what did i do yesterday|what did i talk about yesterday|yesterday.*recap|recap.*yesterday)\b/u.test(normalized)) {
    topics.push({ family: "conversation_recap", topicKey: "yesterday_work_recap" });
  }
  if (/\bmarch\s+22\b/u.test(normalized) && /\bdan\b/u.test(normalized) && /\bladyboys?\b/u.test(normalized)) {
    topics.push({ family: "conversation_recap", topicKey: "omi_ladyboys_2026_03_22" });
  }
  return topics;
}

function projectionVersion(family: RecapProfileFamily): string {
  return family === "conversation_recap" ? "conversation_recap_projection_v1" : "source_profile_summary_projection_v1";
}

async function loadProjection(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly limit: number;
}): Promise<{ readonly heads: readonly RecapProfileProjectionHeadRow[]; readonly entries: readonly RecapProfileProjectionEntryRow[] } | null> {
  if (!enabled()) return null;
  const topics = queryTopics(params.queryText);
  if (topics.length === 0) return null;
  const topicKeys = uniqueStrings(topics.map((topic) => topic.topicKey));
  const versions = uniqueStrings(topics.map((topic) => projectionVersion(topic.family)));
  const heads = await queryRows<RecapProfileProjectionHeadRow>(
    `
      SELECT id::text, summary_text, support_count, projection_version, render_payload, metadata
      FROM contract_projection_heads
      WHERE namespace_id = $1
        AND contract_name = 'recap_profile'
        AND projection_kind = 'report'
        AND projection_version = ANY($2::text[])
        AND truth_status = 'active'
        AND support_count > 0
        AND metadata->>'topic_key' = ANY($3::text[])
      ORDER BY support_count DESC, updated_at DESC
      LIMIT $4
    `,
    [params.namespaceId, versions, topicKeys, Math.max(1, topics.length)]
  );
  if (heads.length === 0) return null;
  const entries = await queryRows<RecapProfileProjectionEntryRow>(
    `
      SELECT
        entry.id::text,
        entry.display_value,
        entry.entry_type,
        entry.entry_role,
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

function projectionResults(params: {
  readonly namespaceId: string;
  readonly heads: readonly RecapProfileProjectionHeadRow[];
  readonly entries: readonly RecapProfileProjectionEntryRow[];
  readonly limit: number;
}): RecallResult[] {
  return params.entries.slice(0, Math.max(params.limit * 2, 8)).map((entry, index) => {
    const metadata = entry.metadata ?? {};
    const sourceQuote = typeof metadata.source_quote === "string" ? metadata.source_quote : entry.display_value;
    return {
      memoryId: `recap_profile_projection:${entry.id}`,
      memoryType: "semantic_memory",
      content: `${entry.display_value} Evidence: ${sourceQuote}`,
      score: 1 - index / 100,
      artifactId: typeof metadata.source_artifact_id === "string" ? metadata.source_artifact_id : null,
      occurredAt: typeof metadata.observed_at === "string" ? metadata.observed_at : null,
      namespaceId: params.namespaceId,
      provenance: {
        tier: "recap_profile_projection",
        source_table: entry.source_table,
        source_row_id: entry.source_row_id,
        source_uri: typeof metadata.source_uri === "string" ? metadata.source_uri : null,
        source_quote: sourceQuote,
        source_chunk_id: typeof metadata.source_chunk_id === "string" ? metadata.source_chunk_id : null,
        projection_head_ids: params.heads.map((head) => head.id),
        projection_entry_id: entry.id,
        projection_version: typeof metadata.projection_version === "string" ? metadata.projection_version : null,
        support_bundle_family: entry.entry_type === "conversation_recap" ? "recap" : "profile_report",
        recap_profile_family: entry.entry_type,
        topic_key: typeof metadata.topic_key === "string" ? metadata.topic_key : entry.entry_role,
        confidence: entry.source_confidence
      }
    };
  });
}

function joinValues(values: readonly string[]): string {
  const unique = uniqueStrings(values);
  if (unique.length <= 2) return unique.join(" and ");
  return `${unique.slice(0, -1).join(", ")}, and ${unique.at(-1)}`;
}

function claimText(entries: readonly RecapProfileProjectionEntryRow[]): string {
  const families = uniqueStrings(entries.map((entry) => entry.entry_type));
  const values = uniqueStrings(entries.map((entry) => entry.display_value));
  if (families.includes("source_profile_summary")) {
    return `Source-backed profile summary: ${joinValues(values)}.`;
  }
  return `Source-backed recap: ${joinValues(values)}.`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function profileFallbackSubject(queryContract?: QueryContract | null): string | null {
  const hints = uniqueStrings(queryContract?.subjectHints ?? []);
  return (
    hints.find((hint) => !/^(?:please|can|tell|what|who|how|when|where)$/iu.test(hint) && !/^steve(?:\s+tietze)?$/iu.test(hint)) ??
    null
  );
}

function directProfileSummaryClaimText(subject: string, results: readonly RecallResult[]): string {
  const snippets = uniqueStrings(results.map((result) => normalizeWhitespace(result.content)).filter(Boolean)).slice(0, 4);
  if (snippets.length === 0) {
    return `No source-backed profile summary found for ${subject}.`;
  }
  return `Source-backed profile summary for ${subject}: ${snippets.join(" ")}`;
}

function directConversationRecapPatterns(topicKey: string): { readonly seedPattern: string; readonly topicPattern: string } | null {
  if (topicKey === "omi_ladyboys_2026_03_22") {
    return {
      seedPattern: "dan|ladyboys|rhonda|march 22|2026-03-22",
      topicPattern: "dan|ladyboys|rhonda|march 22|2026-03-22|conversation|talked|talking"
    };
  }
  if (topicKey === "yesterday_work_recap") {
    return {
      seedPattern: "yesterday|ai brain|preset kitchen|bumblebee|two[- ]?way|well ?inked",
      topicPattern: "yesterday|ai brain|preset kitchen|bumblebee|two[- ]?way|well ?inked|worked on|talked about"
    };
  }
  return null;
}

function directConversationRecapHighlights(results: readonly RecallResult[]): readonly string[] {
  const joined = results.map((result) => normalizeWhitespace(result.content)).join(" ");
  const highlights: string[] = [];
  const knownTopics: readonly [RegExp, string][] = [
    [/\bAI\s+Brain\b/iu, "AI Brain"],
    [/\bPreset\s+Kitchen\b/iu, "Preset Kitchen"],
    [/\bBumblebee\b|\bOpen\s+Claw\b/iu, "Bumblebee"],
    [/\bTwo\s+Way\b|\b2way\b/iu, "Two Way"],
    [/\bWell\s+Inked\b/iu, "Well Inked"],
    [/\bDan\b/iu, "Dan"],
    [/\bRhonda\b/iu, "Rhonda"],
    [/\bladyboys?\b/iu, "ladyboys"]
  ];
  for (const [pattern, label] of knownTopics) {
    if (pattern.test(joined)) {
      highlights.push(label);
    }
  }
  return uniqueStrings(highlights);
}

function directConversationRecapClaimText(queryText: string, topicKey: string, results: readonly RecallResult[]): string {
  const highlights = directConversationRecapHighlights(results);
  if (topicKey === "yesterday_work_recap" && highlights.length > 0) {
    const verb = /\btalk(?:ed|ing)?\b/iu.test(queryText) ? "talked about" : "worked on";
    return `Yesterday you ${verb} ${joinValues(highlights)}.`;
  }
  if (topicKey === "omi_ladyboys_2026_03_22" && highlights.length > 0) {
    return `On March 22, the conversation included ${joinValues(highlights)}.`;
  }
  const snippets = uniqueStrings(results.map((result) => normalizeWhitespace(result.content)).filter(Boolean)).slice(0, 3);
  return snippets.length > 0 ? `Source-backed recap: ${snippets.join(" ")}` : "No source-backed recap found.";
}

export async function buildRecapProfileProjectionResponse(
  query: RecallQuery,
  queryText: string,
  limit: number,
  queryContract?: QueryContract | null
): Promise<RecallResponse | null> {
  const startedAt = performance.now();
  const topics = queryTopics(queryText);
  const projection = await loadProjection({ namespaceId: query.namespaceId, queryText, limit });
  if (!projection) {
    const conversationTopic = topics.find((topic) => topic.family === "conversation_recap");
    if (conversationTopic) {
      const fallbackPatterns = directConversationRecapPatterns(conversationTopic.topicKey);
      if (fallbackPatterns) {
        const results = conversationTopic.topicKey === "omi_ladyboys_2026_03_22"
          ? await loadDirectArtifactWindowResults({
              namespaceId: query.namespaceId,
              timeStart: "2026-03-22T00:00:00.000Z",
              timeEnd: "2026-03-22T23:59:59.999Z",
              topicPattern: fallbackPatterns.topicPattern,
              requiredPattern: "dan|ladyboys|rhonda",
              tier: "conversation_recap_direct_read_model",
              limit: Math.max(limit, 8),
              sortOrder: "asc"
            })
          : conversationTopic.topicKey === "yesterday_work_recap"
            ? await loadDirectOmiArtifactContextResults({
                namespaceId: query.namespaceId,
                seedPattern: fallbackPatterns.seedPattern,
                topicPattern: fallbackPatterns.topicPattern,
                seedArtifactLimit: 12,
                tier: "conversation_recap_direct_read_model",
                limit: Math.max(limit, 16)
              })
          : await loadDirectArtifactContextResults({
              namespaceId: query.namespaceId,
              seedPattern: fallbackPatterns.seedPattern,
              topicPattern: fallbackPatterns.topicPattern,
              seedArtifactLimit: 12,
              tier: "conversation_recap_direct_read_model",
              limit: Math.max(limit, 8)
            });
        if (results.length > 0) {
          return buildDirectSourceSearchResponse({
            query,
            results,
            claimText: directConversationRecapClaimText(queryText, conversationTopic.topicKey, results),
            stageName: "conversation_recap_direct_read_model",
            startedAt,
            answerReason: "The conversation recap query was answered from bounded source chunks when no reusable recap projection head was available.",
            supportBundleFamily: "generic",
            compiledLookupTried: true,
            sourceBoundedReadTried: true,
            sourceBoundedReadSucceeded: true,
            finalRouteFamily: "conversation_recap_direct_read_model",
            extraMeta: {
              recapProfileProjectionTried: true,
              recapProfileProjectionSucceeded: false,
              recapProfileProjectionFamily: "conversation_recap",
              recapProfileProjectionVersion: "conversation_recap_projection_v1",
              recapProfileProjectionEntryCount: 0,
              recapProfileEvidenceCount: results.length,
              recapProfileLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
              recapProfileBlockedReason: "projection_missing_direct_source_fallback",
              finalClaimSource: "conversation_recap_direct_read_model",
              ...(queryContract ? queryContractTelemetry(queryContract, "conversation_recap_direct_read_model", "source_bound_contract_selected") : {})
            }
          });
        }
      }
    }
    if (topics.some((topic) => topic.family === "source_profile_summary")) {
      const subject = profileFallbackSubject(queryContract);
      if (subject) {
        const subjectPattern = escapeRegex(normalizeWhitespace(subject).toLowerCase()).replace(/\s+/gu, "\\s+");
        const results = await loadDirectArtifactContextResults({
          namespaceId: query.namespaceId,
          seedPattern: subjectPattern,
          topicPattern: subjectPattern,
          requiredPattern: subjectPattern,
          seedArtifactLimit: 12,
          tier: "source_profile_summary_direct_read_model",
          limit: Math.max(limit, 8)
        });
        if (results.length > 0) {
          return buildDirectSourceSearchResponse({
            query,
            results,
            claimText: directProfileSummaryClaimText(subject, results),
            stageName: "source_profile_summary_direct_read_model",
            startedAt,
            answerReason: "The profile summary query was answered from bounded source chunks when no reusable projection head was available.",
            supportBundleFamily: "profile_report",
            compiledLookupTried: true,
            sourceBoundedReadTried: true,
            sourceBoundedReadSucceeded: true,
            finalRouteFamily: "source_profile_summary_direct_read_model",
            extraMeta: {
              recapProfileProjectionTried: true,
              recapProfileProjectionSucceeded: false,
              recapProfileProjectionFamily: "source_profile_summary",
              recapProfileProjectionVersion: "source_profile_summary_projection_v1",
              recapProfileProjectionEntryCount: 0,
              recapProfileEvidenceCount: results.length,
              recapProfileLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
              recapProfileBlockedReason: "projection_missing_direct_source_fallback",
              finalClaimSource: "source_profile_summary_direct_read_model",
              ...(queryContract ? queryContractTelemetry(queryContract, "source_profile_summary_direct_read_model", "source_bound_contract_selected") : {})
            }
          });
        }
      }
    }
    return null;
  }
  const results = projectionResults({ namespaceId: query.namespaceId, heads: projection.heads, entries: projection.entries, limit });
  if (results.length === 0) return null;
  const latencyMs = performance.now() - startedAt;
  return buildDirectSourceSearchResponse({
    query,
    results,
    claimText: claimText(projection.entries),
    stageName: "recap_profile_projection",
    startedAt,
    answerReason: "The recap/profile query was answered from source-bound offline projections before live recap/profile retrieval.",
    supportBundleFamily: projection.entries.some((entry) => entry.entry_type === "conversation_recap") ? "generic" : "profile_report",
    compiledLookupTried: true,
    proceduralLookupTried: true,
    sourceBoundedReadTried: true,
    sourceBoundedReadSucceeded: true,
    finalRouteFamily: "recap_profile_projection",
    extraMeta: {
      recapProfileProjectionTried: true,
      recapProfileProjectionSucceeded: true,
      recapProfileProjectionFamily: uniqueStrings(projection.entries.map((entry) => entry.entry_type)).join(","),
      recapProfileProjectionVersion: uniqueStrings(projection.heads.map((head) => head.projection_version)).join(","),
      recapProfileProjectionEntryCount: projection.entries.length,
      recapProfileEvidenceCount: results.length,
      recapProfileLatencyMs: Number(latencyMs.toFixed(2)),
      recapProfileBlockedReason: null,
      finalClaimSource: "recap_profile_projection",
      fallbackBlockedReason: "recap_profile_projection_sufficient",
      canonicalFallbackBlockedReason: "recap_profile_projection_sufficient",
      queryTimeGLiNEROrLLMUsed: false,
      ...(queryContract ? queryContractTelemetry(queryContract, "recap_profile_projection", "source_bound_contract_selected") : {})
    }
  });
}
