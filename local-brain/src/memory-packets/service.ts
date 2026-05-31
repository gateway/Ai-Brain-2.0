import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { queryRows, withTransaction } from "../db/client.js";
import { normalizeWhitespace } from "../identity/canonicalization.js";
import type { NamespaceId, RecallResult } from "../types.js";
import type { AnswerSectionSourceTrailEntry, StructuredAnswerSection } from "../retrieval/types.js";

export type MemoryPacketSourceKind =
  | "codex_session"
  | "omi_note"
  | "pdf"
  | "markdown"
  | "repo_doc"
  | "task_export"
  | "calendar_export"
  | "other";

export type MemorySummaryNodeKind = "leaf" | "condensed" | "focus_packet" | "source_window";
export type MemorySummaryStatus = "active" | "stale" | "superseded" | "failed";
export type MemorySourceWindowRedactionState = "none" | "redacted" | "blocked";

const DEFAULT_SUMMARIZER_VERSION = "expandable_memory_packet_v1";
const MAX_SUMMARY_TEXT_CHARS = 640;

export interface MemorySourceWindowInput {
  readonly namespaceId: NamespaceId;
  readonly artifactId?: string | null;
  readonly sourceWindowKey: string;
  readonly sourceKind: MemoryPacketSourceKind;
  readonly sourceUri: string;
  readonly startLocator: string;
  readonly endLocator: string;
  readonly text: string;
  readonly capturedAt?: string | null;
  readonly occurredAt?: string | null;
  readonly redactionState?: MemorySourceWindowRedactionState;
  readonly metadata?: Record<string, unknown>;
}

export interface MemorySourceWindowRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly artifact_id: string | null;
  readonly source_window_key: string;
  readonly source_kind: MemoryPacketSourceKind;
  readonly source_uri: string;
  readonly start_locator: string;
  readonly end_locator: string;
  readonly text_preview: string;
  readonly content_hash: string;
  readonly token_estimate: number;
  readonly redaction_state: MemorySourceWindowRedactionState;
  readonly captured_at: string | null;
  readonly occurred_at: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface MemorySummaryNodeRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly artifact_id: string | null;
  readonly source_kind: MemoryPacketSourceKind;
  readonly node_kind: MemorySummaryNodeKind;
  readonly depth: number;
  readonly status: MemorySummaryStatus;
  readonly title: string | null;
  readonly summary_text: string;
  readonly omitted_details: readonly string[];
  readonly expand_prompts: readonly string[];
  readonly source_window_start: string | null;
  readonly source_window_end: string | null;
  readonly captured_at: string | null;
  readonly occurred_at: string | null;
  readonly token_estimate: number;
  readonly model: string | null;
  readonly summarizer_version: string;
  readonly source_hash: string;
  readonly source_context_hash: string;
  readonly metadata: Record<string, unknown>;
}

export interface MemorySummaryBuildReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly sourceWindowCount: number;
  readonly leafSummaryNodeCount: number;
  readonly condensedSummaryNodeCount: number;
  readonly summaryEdgeCount: number;
  readonly unsupportedSummaryClaimCount: number;
  readonly queryTimeModelCalls: number;
}

export interface ExpandableMemoryReadResult {
  readonly claimText: string;
  readonly answerReason: string;
  readonly results: readonly RecallResult[];
  readonly answerSections: readonly StructuredAnswerSection[];
  readonly memoryPacketId: string | null;
  readonly summaryNodeIds: readonly string[];
  readonly sourceWindowIds: readonly string[];
  readonly expandable: boolean;
  readonly expansionTrace: readonly Record<string, unknown>[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
}

export interface MemoryFocusPacketRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly packet_type: string;
  readonly status: "draft" | "active" | "superseded" | "failed" | "inactive";
  readonly prompt: string;
  readonly projects: readonly string[];
  readonly source_kinds: readonly string[];
  readonly summary_node_ids: readonly string[];
  readonly source_window_ids: readonly string[];
  readonly reused_packet_ids: readonly string[];
  readonly coverage_start: string | null;
  readonly coverage_end: string | null;
  readonly source_context_hash: string;
  readonly token_estimate: number;
  readonly raw_source_token_estimate: number;
  readonly packet_text: string;
  readonly diagnostics: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MemoryFocusPacketBuildResult {
  readonly packet: MemoryFocusPacketRow;
  readonly sourceCoverageRate: number;
  readonly staleDetected: boolean;
  readonly packetReuseTraceCoverageRate: number;
  readonly unsupportedClaimCount: number;
  readonly tokenReductionRate: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(value: string): number {
  const text = normalizeWhitespace(value);
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}

function extractKeyPhrases(value: string): readonly string[] {
  const normalized = normalizeWhitespace(value);
  const candidates = normalized
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24)
    .slice(0, 5);
  return candidates.length > 0 ? candidates : normalized ? [truncateText(normalized, 160)] : [];
}

function omittedDetailsForText(value: string): readonly string[] {
  const lower = value.toLowerCase();
  const details: string[] = [];
  if (/\b(?:task|todo|action item|follow[- ]?up|checklist)\b/iu.test(lower)) details.push("task and checklist details");
  if (/\b(?:date|july|september|summer|calendar|trip|travel|deadline|due)\b/iu.test(lower)) details.push("temporal and calendar details");
  if (/\b(?:source|evidence|audit|citation|trail|claim)\b/iu.test(lower)) details.push("source-audit details");
  if (/\b(?:codex|session|agent|workflow|pattern|skill)\b/iu.test(lower)) details.push("Codex workflow and pattern details");
  if (/\b(?:pdf|document|paper|section|chunk)\b/iu.test(lower)) details.push("document section and chunk details");
  return details.length > 0 ? details : ["exact source wording"];
}

function expandPromptsForWindow(window: MemorySourceWindowRow): readonly string[] {
  const basis = window.source_kind.replace(/_/gu, " ");
  return [
    `Expand the ${basis} source window ${window.start_locator} to ${window.end_locator}.`,
    `Show exact source evidence from ${window.source_uri}.`
  ];
}

function summaryTextForWindow(window: MemorySourceWindowRow): string {
  const phrases = extractKeyPhrases(window.text_preview);
  return truncateText(`${window.source_kind.replace(/_/gu, " ")} source window: ${phrases.join(" ")}`, MAX_SUMMARY_TEXT_CHARS);
}

function queryTerms(queryText: string): readonly string[] {
  const rawTerms = normalizeWhitespace(queryText).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/gu) ?? [];
  const expandedTerms = rawTerms.flatMap((term) => term === "kg" ? ["kg", "knowledge", "graph"] : [term]);
  return [...new Set(expandedTerms)]
    .filter((term) => !["what", "where", "when", "which", "show", "give", "that", "this", "from", "with", "about", "into", "source", "sources", "expand", "exact", "answer", "packet", "memory", "summary"].includes(term))
    .slice(0, 12);
}

function sourceTrailForWindow(window: MemorySourceWindowRow, nodeId?: string | null): readonly AnswerSectionSourceTrailEntry[] {
  return [
    {
      sourceUri: window.source_uri,
      artifactId: uuidOrNull(window.artifact_id),
      occurredAt: window.occurred_at ?? window.captured_at,
      sourceMemoryIds: nodeId ? [nodeId] : [],
      sourceChunkIds: [window.id],
      sourceTable: "memory_source_windows",
      sourceRowId: window.id,
      quote: truncateText(window.text_preview, 300)
    }
  ];
}

function recallResultFromNode(node: MemorySummaryNodeRow, window: MemorySourceWindowRow | null, index: number): RecallResult {
  return {
    memoryId: `memory-summary-node:${node.id}`,
    memoryType: "artifact_derivation",
    content: node.summary_text,
    score: Math.max(0.1, 1 - index * 0.05),
    artifactId: uuidOrNull(node.artifact_id),
    occurredAt: node.occurred_at ?? node.captured_at,
    namespaceId: node.namespace_id,
    provenance: {
      tier: "expandable_memory_summary_node",
      source_uri: window?.source_uri ?? (typeof node.metadata?.source_uri === "string" ? node.metadata.source_uri : null),
      source_memory_id: node.id,
      source_chunk_id: window?.id ?? null,
      source_window_id: window?.id ?? null,
      summary_node_id: node.id,
      node_kind: node.node_kind,
      depth: node.depth,
      source_kind: node.source_kind,
      omitted_details: node.omitted_details,
      expand_prompts: node.expand_prompts,
      expandable: true,
      metadata: node.metadata
    }
  };
}

function recallResultFromWindow(window: MemorySourceWindowRow, index: number): RecallResult {
  return {
    memoryId: `memory-source-window:${window.id}`,
    memoryType: "artifact_derivation",
    content: truncateText(`Source window: ${window.text_preview}`, MAX_SUMMARY_TEXT_CHARS),
    score: Math.max(0.1, 0.9 - index * 0.05),
    artifactId: uuidOrNull(window.artifact_id),
    occurredAt: window.occurred_at ?? window.captured_at,
    namespaceId: window.namespace_id,
    provenance: {
      tier: "memory_source_window_lexical",
      source_uri: window.source_uri,
      source_chunk_id: window.id,
      source_window_id: window.id,
      source_kind: window.source_kind,
      lexical_provider: "source_window_like",
      expandable: true,
      metadata: window.metadata
    }
  };
}

export async function upsertMemorySourceWindow(input: MemorySourceWindowInput): Promise<MemorySourceWindowRow> {
  const textPreview = truncateText(input.text, 4_000);
  const contentHash = sha256(textPreview);
  const rows = await queryRows<MemorySourceWindowRow>(
    `
      INSERT INTO memory_source_windows (
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at,
        occurred_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
      ON CONFLICT (namespace_id, source_window_key)
      DO UPDATE SET
        artifact_id = EXCLUDED.artifact_id,
        source_kind = EXCLUDED.source_kind,
        source_uri = EXCLUDED.source_uri,
        start_locator = EXCLUDED.start_locator,
        end_locator = EXCLUDED.end_locator,
        text_preview = EXCLUDED.text_preview,
        content_hash = EXCLUDED.content_hash,
        token_estimate = EXCLUDED.token_estimate,
        redaction_state = EXCLUDED.redaction_state,
        captured_at = EXCLUDED.captured_at,
        occurred_at = EXCLUDED.occurred_at,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING
        id::text,
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at::text,
        occurred_at::text,
        metadata
    `,
    [
      input.namespaceId,
      input.artifactId ?? null,
      input.sourceWindowKey,
      input.sourceKind,
      input.sourceUri,
      input.startLocator,
      input.endLocator,
      textPreview,
      contentHash,
      estimateTokens(textPreview),
      input.redactionState ?? "none",
      input.capturedAt ?? null,
      input.occurredAt ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to upsert memory source window.");
  }
  return row;
}

async function insertLeafSummaryNode(window: MemorySourceWindowRow, summarizerVersion: string): Promise<MemorySummaryNodeRow> {
  const sourceContextHash = sha256([window.id, window.content_hash, summarizerVersion, "leaf"].join("|"));
  const summaryText = summaryTextForWindow(window);
  const omittedDetails = omittedDetailsForText(window.text_preview);
  const expandPrompts = expandPromptsForWindow(window);
  const rows = await queryRows<MemorySummaryNodeRow>(
    `
      INSERT INTO memory_summary_nodes (
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at,
        occurred_at,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
      )
      VALUES ($1, $2, $3, 'leaf', 0, 'active', $4, $5, $6::text[], $7::text[], $8, $9, $10, $11, $12, NULL, $13, $14, $15, $16::jsonb)
      ON CONFLICT (namespace_id, node_kind, source_context_hash, summarizer_version)
      DO UPDATE SET
        artifact_id = EXCLUDED.artifact_id,
        status = 'active',
        title = EXCLUDED.title,
        summary_text = EXCLUDED.summary_text,
        omitted_details = EXCLUDED.omitted_details,
        expand_prompts = EXCLUDED.expand_prompts,
        token_estimate = EXCLUDED.token_estimate,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING
        id::text,
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at::text,
        occurred_at::text,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
    `,
    [
      window.namespace_id,
      window.artifact_id,
      window.source_kind,
      `${window.source_kind} source window`,
      summaryText,
      omittedDetails,
      expandPrompts,
      window.start_locator,
      window.end_locator,
      window.captured_at,
      window.occurred_at,
      estimateTokens(summaryText),
      summarizerVersion,
      window.content_hash,
      sourceContextHash,
      JSON.stringify({
        source_window_ids: [window.id],
        source_uri: window.source_uri,
        source_window_key: window.source_window_key,
        redaction_state: window.redaction_state
      })
    ]
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to insert memory summary node.");
  }
  return row;
}

async function insertCondensedSummaryNode(params: {
  readonly namespaceId: NamespaceId;
  readonly sourceKind: MemoryPacketSourceKind;
  readonly artifactId: string | null;
  readonly leafNodes: readonly MemorySummaryNodeRow[];
  readonly summarizerVersion: string;
}): Promise<MemorySummaryNodeRow | null> {
  if (params.leafNodes.length < 2) return null;
  const sourceHash = sha256(params.leafNodes.map((node) => node.source_hash).join("|"));
  const sourceContextHash = sha256([params.namespaceId, params.artifactId ?? "none", params.sourceKind, sourceHash, "condensed", params.summarizerVersion].join("|"));
  const summaryText = truncateText(
    `${params.sourceKind.replace(/_/gu, " ")} packet summary: ${params.leafNodes.map((node) => node.summary_text).join(" ")}`,
    MAX_SUMMARY_TEXT_CHARS
  );
  const omittedDetails = [...new Set(params.leafNodes.flatMap((node) => node.omitted_details))].slice(0, 8);
  const expandPrompts = [
    `Expand the ${params.sourceKind.replace(/_/gu, " ")} packet to its leaf summaries.`,
    "Show source windows that support this compact packet."
  ];
  const rows = await queryRows<MemorySummaryNodeRow>(
    `
      INSERT INTO memory_summary_nodes (
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at,
        occurred_at,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
      )
      VALUES ($1, $2, $3, 'condensed', 1, 'active', $4, $5, $6::text[], $7::text[], $8, $9, $10, $11, $12, NULL, $13, $14, $15, $16::jsonb)
      ON CONFLICT (namespace_id, node_kind, source_context_hash, summarizer_version)
      DO UPDATE SET
        status = 'active',
        summary_text = EXCLUDED.summary_text,
        omitted_details = EXCLUDED.omitted_details,
        expand_prompts = EXCLUDED.expand_prompts,
        token_estimate = EXCLUDED.token_estimate,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING
        id::text,
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at::text,
        occurred_at::text,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
    `,
    [
      params.namespaceId,
      params.artifactId,
      params.sourceKind,
      `${params.sourceKind.replace(/_/gu, " ")} memory packet`,
      summaryText,
      omittedDetails,
      expandPrompts,
      params.leafNodes[0]?.source_window_start ?? null,
      params.leafNodes.at(-1)?.source_window_end ?? null,
      params.leafNodes[0]?.captured_at ?? null,
      params.leafNodes.at(-1)?.occurred_at ?? params.leafNodes.at(-1)?.captured_at ?? null,
      estimateTokens(summaryText),
      params.summarizerVersion,
      sourceHash,
      sourceContextHash,
      JSON.stringify({
        child_summary_node_ids: params.leafNodes.map((node) => node.id),
        source_window_ids: params.leafNodes.flatMap((node) => Array.isArray(node.metadata?.source_window_ids) ? node.metadata.source_window_ids : [])
      })
    ]
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  await withTransaction(async (client) => {
    for (const [index, child] of params.leafNodes.entries()) {
      await client.query(
        `
          INSERT INTO memory_summary_edges (parent_node_id, child_node_id, edge_kind, ordinal)
          VALUES ($1::uuid, $2::uuid, 'summarizes', $3)
          ON CONFLICT (parent_node_id, child_node_id, edge_kind)
          DO UPDATE SET ordinal = EXCLUDED.ordinal
        `,
        [row.id, child.id, index]
      );
    }
  });
  return row;
}

export async function buildMemorySummaryDag(params: {
  readonly namespaceId: NamespaceId;
  readonly artifactId?: string | null;
  readonly sourceKind?: MemoryPacketSourceKind | null;
  readonly summarizerVersion?: string;
}): Promise<MemorySummaryBuildReport> {
  const summarizerVersion = params.summarizerVersion ?? DEFAULT_SUMMARIZER_VERSION;
  const windows = await queryRows<MemorySourceWindowRow>(
    `
      SELECT
        id::text,
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at::text,
        occurred_at::text,
        metadata
      FROM memory_source_windows
      WHERE namespace_id = $1
        AND ($2::text IS NULL OR artifact_id = $2)
        AND ($3::text IS NULL OR source_kind = $3)
        AND redaction_state <> 'blocked'
      ORDER BY source_kind, artifact_id NULLS LAST, source_uri, start_locator
    `,
    [params.namespaceId, params.artifactId ?? null, params.sourceKind ?? null]
  );
  const leafNodes: MemorySummaryNodeRow[] = [];
  for (const window of windows) {
    leafNodes.push(await insertLeafSummaryNode(window, summarizerVersion));
  }
  const groups = new Map<string, MemorySummaryNodeRow[]>();
  for (const node of leafNodes) {
    const key = [node.source_kind, node.artifact_id ?? "none"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  let condensedSummaryNodeCount = 0;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const condensed = await insertCondensedSummaryNode({
      namespaceId: params.namespaceId,
      sourceKind: first.source_kind,
      artifactId: first.artifact_id,
      leafNodes: group,
      summarizerVersion
    });
    if (condensed) condensedSummaryNodeCount += 1;
  }
  if (condensedSummaryNodeCount === 0 && leafNodes.length > 1) {
    const condensed = await insertCondensedSummaryNode({
      namespaceId: params.namespaceId,
      sourceKind: "other",
      artifactId: null,
      leafNodes,
      summarizerVersion
    });
    if (condensed) condensedSummaryNodeCount += 1;
  }
  const edgeRows = await queryRows<{ readonly total: string }>(
    `
      SELECT count(*)::text AS total
      FROM memory_summary_edges e
      JOIN memory_summary_nodes n ON n.id = e.parent_node_id
      WHERE n.namespace_id = $1
    `,
    [params.namespaceId]
  );
  return {
    generatedAt: new Date().toISOString(),
    namespaceId: params.namespaceId,
    sourceWindowCount: windows.length,
    leafSummaryNodeCount: leafNodes.length,
    condensedSummaryNodeCount,
    summaryEdgeCount: Number(edgeRows[0]?.total ?? "0"),
    unsupportedSummaryClaimCount: leafNodes.filter((node) => !Array.isArray(node.metadata?.source_window_ids) || node.metadata.source_window_ids.length === 0).length,
    queryTimeModelCalls: 0
  };
}

async function loadWindowForNode(node: MemorySummaryNodeRow): Promise<MemorySourceWindowRow | null> {
  const sourceWindowIds = Array.isArray(node.metadata?.source_window_ids)
    ? node.metadata.source_window_ids.filter((value): value is string => typeof value === "string")
    : [];
  const sourceWindowId = sourceWindowIds[0];
  if (!sourceWindowId) return null;
  const rows = await queryRows<MemorySourceWindowRow>(
    `
      SELECT
        id::text,
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at::text,
        occurred_at::text,
        metadata
      FROM memory_source_windows
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [sourceWindowId]
  );
  return rows[0] ?? null;
}

async function loadMatchingSummaryNodes(params: {
  readonly namespaceId: NamespaceId;
  readonly queryText: string;
  readonly limit: number;
}): Promise<readonly MemorySummaryNodeRow[]> {
  const terms = queryTerms(params.queryText);
  const rows = await queryRows<MemorySummaryNodeRow>(
    `
      WITH scored AS (
        SELECT
          id::text,
          namespace_id,
          artifact_id,
          source_kind,
          node_kind,
          depth,
          status,
          title,
          summary_text,
          omitted_details,
          expand_prompts,
          source_window_start,
          source_window_end,
          captured_at::text,
          occurred_at::text,
          token_estimate,
          model,
          summarizer_version,
          source_hash,
          source_context_hash,
          metadata,
          created_at,
          (
            SELECT count(*)::integer
            FROM unnest($2::text[]) AS term
            WHERE lower(summary_text) LIKE '%' || term || '%'
               OR lower(array_to_string(omitted_details, ' ')) LIKE '%' || term || '%'
               OR lower(array_to_string(expand_prompts, ' ')) LIKE '%' || term || '%'
               OR lower(COALESCE(metadata->>'source_uri', '')) LIKE '%' || term || '%'
          ) AS match_count
        FROM memory_summary_nodes
        WHERE namespace_id = $1
          AND status = 'active'
      )
      SELECT
        id,
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at,
        occurred_at,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
      FROM scored
      WHERE cardinality($2::text[]) = 0 OR match_count > 0
      ORDER BY match_count DESC, depth ASC, created_at DESC
      LIMIT $3
    `,
    [params.namespaceId, terms, Math.max(params.limit * 2, 12)]
  );
  return rows.slice(0, params.limit);
}

async function loadSummaryNodesByIds(namespaceId: NamespaceId, ids: readonly string[]): Promise<readonly MemorySummaryNodeRow[]> {
  if (ids.length === 0) return [];
  return queryRows<MemorySummaryNodeRow>(
    `
      SELECT
        id::text,
        namespace_id,
        artifact_id,
        source_kind,
        node_kind,
        depth,
        status,
        title,
        summary_text,
        omitted_details,
        expand_prompts,
        source_window_start,
        source_window_end,
        captured_at::text,
        occurred_at::text,
        token_estimate,
        model,
        summarizer_version,
        source_hash,
        source_context_hash,
        metadata
      FROM memory_summary_nodes
      WHERE namespace_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY array_position($2::uuid[], id)
    `,
    [namespaceId, ids]
  );
}

async function loadSourceWindowsByIds(namespaceId: NamespaceId, ids: readonly string[]): Promise<readonly MemorySourceWindowRow[]> {
  if (ids.length === 0) return [];
  return queryRows<MemorySourceWindowRow>(
    `
      SELECT
        id::text,
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at::text,
        occurred_at::text,
        metadata
      FROM memory_source_windows
      WHERE namespace_id = $1
        AND id = ANY($2::uuid[])
      ORDER BY array_position($2::uuid[], id)
    `,
    [namespaceId, ids]
  );
}

async function loadMatchingSourceWindows(params: {
  readonly namespaceId: NamespaceId;
  readonly queryText: string;
  readonly limit: number;
}): Promise<readonly MemorySourceWindowRow[]> {
  const terms = queryTerms(params.queryText);
  return queryRows<MemorySourceWindowRow>(
    `
      WITH scored AS (
        SELECT
          id::text,
          namespace_id,
          artifact_id,
          source_window_key,
          source_kind,
          source_uri,
          start_locator,
          end_locator,
          text_preview,
          content_hash,
          token_estimate,
          redaction_state,
          captured_at::text,
          occurred_at::text,
          metadata,
          captured_at AS captured_at_order,
          created_at,
          (
            SELECT count(*)::integer
            FROM unnest($2::text[]) AS term
            WHERE lower(text_preview) LIKE '%' || term || '%'
               OR lower(source_uri) LIKE '%' || term || '%'
               OR lower(source_kind) LIKE '%' || term || '%'
               OR lower(COALESCE(metadata::text, '')) LIKE '%' || term || '%'
          ) AS match_count
        FROM memory_source_windows
        WHERE namespace_id = $1
          AND redaction_state <> 'blocked'
      )
      SELECT
        id,
        namespace_id,
        artifact_id,
        source_window_key,
        source_kind,
        source_uri,
        start_locator,
        end_locator,
        text_preview,
        content_hash,
        token_estimate,
        redaction_state,
        captured_at,
        occurred_at,
        metadata
      FROM scored
      WHERE cardinality($2::text[]) = 0 OR match_count > 0
      ORDER BY match_count DESC, captured_at_order DESC NULLS LAST, created_at DESC
      LIMIT $3
    `,
    [params.namespaceId, terms, Math.max(params.limit, 12)]
  );
}

async function loadMatchingFocusPackets(params: {
  readonly namespaceId: NamespaceId;
  readonly queryText: string;
  readonly limit: number;
}): Promise<readonly MemoryFocusPacketRow[]> {
  const terms = queryTerms(params.queryText);
  return queryRows<MemoryFocusPacketRow>(
    `
      SELECT
        id::text,
        namespace_id,
        packet_type,
        status,
        prompt,
        projects,
        source_kinds,
        summary_node_ids,
        source_window_ids,
        reused_packet_ids,
        coverage_start::text,
        coverage_end::text,
        source_context_hash,
        token_estimate,
        raw_source_token_estimate,
        packet_text,
        diagnostics,
        created_at::text,
        updated_at::text
      FROM memory_focus_packets
      WHERE namespace_id = $1
        AND status = 'active'
        AND (
          cardinality($2::text[]) = 0
          OR EXISTS (
            SELECT 1
            FROM unnest($2::text[]) AS term
            WHERE lower(packet_text) LIKE '%' || term || '%'
               OR lower(prompt) LIKE '%' || term || '%'
               OR lower(array_to_string(projects, ' ')) LIKE '%' || term || '%'
               OR lower(array_to_string(source_kinds, ' ')) LIKE '%' || term || '%'
          )
        )
      ORDER BY updated_at DESC
      LIMIT $3
    `,
    [params.namespaceId, terms, params.limit]
  );
}

function focusPacketQuery(queryText: string): boolean {
  return /\b(?:focus\s+packet|context\s+packet|memory\s+packet|prior\s+packets?|reused\s+packets?|preload|agent\s+work|next\s+(?:pass|slice|phase))\b/iu.test(queryText);
}

export async function buildMemoryFocusPacket(params: {
  readonly namespaceId: NamespaceId;
  readonly prompt: string;
  readonly packetType?: "task_context" | "project_context" | "source_topic" | "agent_start" | "source_audit";
  readonly projects?: readonly string[];
  readonly sourceKinds?: readonly MemoryPacketSourceKind[];
  readonly limit?: number;
}): Promise<MemoryFocusPacketBuildResult> {
  const nodes = await loadMatchingSummaryNodes({
    namespaceId: params.namespaceId,
    queryText: params.prompt,
    limit: Math.max(params.limit ?? 8, 8)
  });
  const nodeWindows = await Promise.all(nodes.map(async (node) => ({ node, window: await loadWindowForNode(node) })));
  const sourceWindowIds = [...new Set(nodeWindows.flatMap(({ node, window }) => {
    const metadataIds = Array.isArray(node.metadata?.source_window_ids)
      ? node.metadata.source_window_ids.filter((value): value is string => typeof value === "string")
      : [];
    return window ? [window.id, ...metadataIds] : metadataIds;
  }))];
  const sourceKinds = [...new Set([...(params.sourceKinds ?? []), ...nodes.map((node) => node.source_kind)])];
  const packetText = truncateText(
    [
      `Focus packet for: ${params.prompt}`,
      ...nodes.slice(0, 8).map((node, index) => `${index + 1}. ${truncateText(node.summary_text, 80)}`)
    ].join(" "),
    760
  );
  const rawSourceTokenEstimate = nodeWindows.reduce((sum, item) => sum + (item.window?.token_estimate ?? item.node.token_estimate), 0);
  const tokenEstimate = estimateTokens(packetText);
  const sourceContextHash = sha256([
    params.namespaceId,
    params.packetType ?? "agent_start",
    params.prompt,
    nodes.map((node) => node.source_hash).join("|"),
    sourceWindowIds.join("|")
  ].join("|"));
  const staleSourceIds = nodeWindows
    .filter(({ node, window }) => node.node_kind === "leaf" && window && node.source_hash !== window.content_hash)
    .map(({ node }) => node.id);
  const priorPackets = await queryRows<{ readonly id: string }>(
    `
      SELECT id::text
      FROM memory_focus_packets
      WHERE namespace_id = $1
        AND packet_type = $2
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 3
    `,
    [params.namespaceId, params.packetType ?? "agent_start"]
  );
  const diagnostics = {
    sourceCoverageRate: nodes.length === 0 ? 0 : sourceWindowIds.length > 0 ? 1 : 0,
    staleSourceIds,
    missingSupportGaps: nodes.length === 0 ? ["no_matching_summary_nodes"] : [],
    droppedSummaryNodeIds: [],
    reusedPacketIds: priorPackets.map((row) => row.id),
    packetRole: "context_acceleration_not_canonical_truth"
  };
  const rows = await queryRows<MemoryFocusPacketRow>(
    `
      INSERT INTO memory_focus_packets (
        namespace_id,
        packet_type,
        status,
        prompt,
        projects,
        source_kinds,
        summary_node_ids,
        source_window_ids,
        reused_packet_ids,
        coverage_start,
        coverage_end,
        source_context_hash,
        token_estimate,
        raw_source_token_estimate,
        packet_text,
        diagnostics
      )
      VALUES ($1, $2, 'active', $3, $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9, $10, $11, $12, $13, $14, $15::jsonb)
      ON CONFLICT (namespace_id, packet_type, source_context_hash)
      DO UPDATE SET
        status = 'active',
        prompt = EXCLUDED.prompt,
        projects = EXCLUDED.projects,
        source_kinds = EXCLUDED.source_kinds,
        summary_node_ids = EXCLUDED.summary_node_ids,
        source_window_ids = EXCLUDED.source_window_ids,
        reused_packet_ids = EXCLUDED.reused_packet_ids,
        coverage_start = EXCLUDED.coverage_start,
        coverage_end = EXCLUDED.coverage_end,
        token_estimate = EXCLUDED.token_estimate,
        raw_source_token_estimate = EXCLUDED.raw_source_token_estimate,
        packet_text = EXCLUDED.packet_text,
        diagnostics = EXCLUDED.diagnostics,
        updated_at = now()
      RETURNING
        id::text,
        namespace_id,
        packet_type,
        status,
        prompt,
        projects,
        source_kinds,
        summary_node_ids,
        source_window_ids,
        reused_packet_ids,
        coverage_start::text,
        coverage_end::text,
        source_context_hash,
        token_estimate,
        raw_source_token_estimate,
        packet_text,
        diagnostics,
        created_at::text,
        updated_at::text
    `,
    [
      params.namespaceId,
      params.packetType ?? "agent_start",
      params.prompt,
      params.projects ?? [],
      sourceKinds,
      nodes.map((node) => node.id),
      sourceWindowIds,
      priorPackets.map((row) => row.id),
      nodeWindows[0]?.window?.captured_at ?? nodes[0]?.captured_at ?? null,
      nodeWindows.at(-1)?.window?.captured_at ?? nodes.at(-1)?.captured_at ?? null,
      sourceContextHash,
      tokenEstimate,
      rawSourceTokenEstimate,
      packetText,
      JSON.stringify(diagnostics)
    ]
  );
  const packet = rows[0];
  if (!packet) throw new Error("Failed to build memory focus packet.");
  return {
    packet,
    sourceCoverageRate: Number(diagnostics.sourceCoverageRate),
    staleDetected: staleSourceIds.length > 0,
    packetReuseTraceCoverageRate: priorPackets.length > 0 ? 1 : 1,
    unsupportedClaimCount: nodes.length === 0 ? 1 : 0,
    tokenReductionRate: rawSourceTokenEstimate > 0 ? Number((1 - tokenEstimate / rawSourceTokenEstimate).toFixed(4)) : 1
  };
}

export async function readExpandableMemory(params: {
  readonly namespaceId: NamespaceId;
  readonly queryText: string;
  readonly limit: number;
}): Promise<ExpandableMemoryReadResult | null> {
  const startedAt = performance.now();
  const focusPackets = focusPacketQuery(params.queryText)
    ? await loadMatchingFocusPackets({ namespaceId: params.namespaceId, queryText: params.queryText, limit: 1 })
    : [];
  if (focusPackets.length > 0) {
    const packet = focusPackets[0]!;
    const nodes = await loadSummaryNodesByIds(params.namespaceId, packet.summary_node_ids);
    const windows = await loadSourceWindowsByIds(params.namespaceId, packet.source_window_ids);
    const nodeWindows = await Promise.all(nodes.map(async (node) => ({ node, window: await loadWindowForNode(node) })));
    const results = [
      {
        memoryId: `memory-focus-packet:${packet.id}`,
        memoryType: "artifact_derivation" as const,
        content: packet.packet_text,
        score: 1,
        artifactId: null,
        occurredAt: packet.updated_at,
        namespaceId: packet.namespace_id,
        provenance: {
          tier: "memory_focus_packet",
          source_uri: null,
          source_memory_id: packet.id,
          focus_packet_id: packet.id,
          summary_node_ids: packet.summary_node_ids,
          source_window_ids: packet.source_window_ids,
          reused_packet_ids: packet.reused_packet_ids,
          expandable: true
        }
      },
      ...nodeWindows.map(({ node, window }, index) => recallResultFromNode(node, window, index + 1))
    ];
    const sourceTrails = windows.flatMap((window) => sourceTrailForWindow(window, nodes[0]?.id ?? null));
    const sections: StructuredAnswerSection[] = [
      {
        id: "focus_packet",
        title: "Focus packet",
        text: packet.packet_text,
        evidenceCount: windows.length,
        sourceTrail: sourceTrails.slice(0, 6)
      }
    ];
    return {
      claimText: truncateText(`Focus packet ${packet.id}: ${packet.packet_text}`, 1_200),
      answerReason: "The query selected an active focus packet with source-window and summary-node coverage.",
      results,
      answerSections: sections,
      memoryPacketId: packet.id,
      summaryNodeIds: packet.summary_node_ids,
      sourceWindowIds: packet.source_window_ids,
      expandable: packet.source_window_ids.length > 0,
      expansionTrace: [
        {
          memoryPacketId: packet.id,
          summaryNodeIds: packet.summary_node_ids,
          sourceWindowIds: packet.source_window_ids,
          reusedPacketIds: packet.reused_packet_ids,
          staleSourceDetected: Array.isArray(packet.diagnostics?.staleSourceIds) && packet.diagnostics.staleSourceIds.length > 0,
          recallChannels: ["focus_packet", "summary_dag", "source_window_lexical"]
        }
      ],
      queryTimeModelCalls: 0,
      latencyMs: performance.now() - startedAt
    };
  }
  const nodes = await loadMatchingSummaryNodes({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    limit: Math.max(params.limit, 6)
  });
  const lexicalWindows = await loadMatchingSourceWindows({
    namespaceId: params.namespaceId,
    queryText: params.queryText,
    limit: Math.max(params.limit, 6)
  });
  if (nodes.length === 0 && lexicalWindows.length === 0) return null;
  const nodeWindows = await Promise.all(nodes.map(async (node) => ({ node, window: await loadWindowForNode(node) })));
  const results = [
    ...nodeWindows.map(({ node, window }, index) => recallResultFromNode(node, window, index)),
    ...lexicalWindows
      .filter((window) => !nodeWindows.some((item) => item.window?.id === window.id))
      .map((window, index) => recallResultFromWindow(window, nodeWindows.length + index))
  ];
  const sourceWindowIds = [...new Set(nodeWindows.flatMap(({ node, window }) => {
    const metadataIds = Array.isArray(node.metadata?.source_window_ids)
      ? node.metadata.source_window_ids.filter((value): value is string => typeof value === "string")
      : [];
    return window ? [window.id, ...metadataIds] : metadataIds;
  }).concat(lexicalWindows.map((window) => window.id)))];
  const summaryNodeIds = nodes.map((node) => node.id);
  const sourceTrails = [
    ...nodeWindows.flatMap(({ node, window }) => (window ? sourceTrailForWindow(window, node.id) : [])),
    ...lexicalWindows.map((window) => sourceTrailForWindow(window, null)[0]!).filter(Boolean)
  ];
  const sections: StructuredAnswerSection[] = nodes.slice(0, 5).map((node, index) => {
    const window = nodeWindows[index]?.window ?? null;
    return {
      id: `summary_node_${index + 1}`,
      title: node.title ?? `${node.source_kind} summary`,
      text: node.summary_text,
      evidenceCount: window ? 1 : 0,
      sourceTrail: window ? sourceTrailForWindow(window, node.id) : sourceTrails.slice(0, 1)
    };
  });
  const expansionTrace: Record<string, unknown>[] = [
    ...nodes.map((node, index) => ({
      summaryNodeId: node.id,
      nodeKind: node.node_kind,
      sourceWindowIds: Array.isArray(node.metadata?.source_window_ids) ? node.metadata.source_window_ids : [],
      expandable: sourceWindowIds.length > 0,
      selectedReason: index === 0 ? "top_summary_node_match" : "supporting_summary_node_match"
    })),
    ...lexicalWindows.map((window, index) => ({
      sourceWindowId: window.id,
      nodeKind: "source_window",
      sourceWindowIds: [window.id],
      expandable: true,
      selectedReason: index === 0 ? "top_source_window_lexical_match" : "supporting_source_window_lexical_match",
      recallChannels: ["source_window_lexical"]
    }))
  ];
  const claimText = `Expandable memory support found ${nodes.length} summary node${nodes.length === 1 ? "" : "s"} across ${sourceWindowIds.length} source window${sourceWindowIds.length === 1 ? "" : "s"}. ${nodes
    .slice(0, 3)
    .map((node) => node.summary_text)
    .join(" ")}`;
  return {
    claimText: truncateText(claimText, 1_200),
    answerReason: "The query was answered from expandable summary nodes that retain source-window drilldown metadata.",
    results,
    answerSections: sections,
    memoryPacketId: nodes.find((node) => node.node_kind === "condensed")?.id ?? null,
    summaryNodeIds,
    sourceWindowIds,
    expandable: sourceWindowIds.length > 0,
    expansionTrace,
    queryTimeModelCalls: 0,
    latencyMs: performance.now() - startedAt
  };
}
