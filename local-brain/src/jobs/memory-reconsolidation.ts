import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";
import type { RecallConfidenceGrade } from "../retrieval/types.js";
import type { RecallResult } from "../types.js";

export interface MemoryReconsolidationSummary {
  readonly runId: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly priorConfidence: RecallConfidenceGrade;
  readonly action: "add" | "update" | "supersede" | "abstain" | "skip";
  readonly semanticMemoryId?: string;
  readonly reason: string;
}

export interface RunMemoryReconsolidationInput {
  readonly namespaceId: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
}

function formatUtcDayLabel(isoStart: string): string {
  return new Date(isoStart).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function normalizeSummaryContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

function formatList(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0]!;
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function buildDaySummaryCanonicalKey(start: string): string {
  return `reconsolidated:day_summary:${start.slice(0, 10)}`;
}

function isWeakOrMissing(confidence: RecallConfidenceGrade): boolean {
  return confidence === "weak" || confidence === "missing";
}

function hasAdequateEvidence(
  results: readonly RecallResult[],
  evidenceCount: number,
  inferredTimeStart?: string,
  inferredTimeEnd?: string
): boolean {
  if (!inferredTimeStart || !inferredTimeEnd) {
    return false;
  }

  if (evidenceCount === 0) {
    return false;
  }

  return results.some((result) => result.memoryType === "temporal_nodes" || result.memoryType === "narrative_event");
}

async function resolveSourceEpisodicId(
  namespaceId: string,
  artifactId: string | null | undefined,
  timeStart: string,
  timeEnd: string
): Promise<string | null> {
  if (!artifactId) {
    return null;
  }

  const row = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND artifact_id = $2::uuid
          AND occurred_at >= $3::timestamptz
          AND occurred_at <= $4::timestamptz
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId, artifactId, timeStart, timeEnd]
    );

    return result.rows[0]?.id ?? null;
  });

  return row;
}

export async function runMemoryReconsolidation(
  input: RunMemoryReconsolidationInput
): Promise<MemoryReconsolidationSummary> {
  const runId = randomUUID();
  const response = await searchMemory({
    namespaceId: input.namespaceId,
    query: input.query,
    timeStart: input.timeStart,
    timeEnd: input.timeEnd,
    limit: input.limit ?? 8
  });

  const priorConfidence = response.meta.answerAssessment?.confidence ?? "missing";
  const inferredTimeStart = response.meta.planner.inferredTimeStart ?? input.timeStart;
  const inferredTimeEnd = response.meta.planner.inferredTimeEnd ?? input.timeEnd;

  if (
    !isWeakOrMissing(priorConfidence) ||
    !hasAdequateEvidence(response.results, response.evidence.length, inferredTimeStart, inferredTimeEnd)
  ) {
    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            reason,
            metadata
          )
          VALUES ($1, $2, $3, 'skip', 'day_summary', $4, $5::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          priorConfidence,
          "Reconsolidation did not trigger because the query was already confident or lacked adequate day-summary evidence.",
          JSON.stringify({
            run_id: runId
          })
        ]
      );
    });

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action: "skip",
      reason: "Reconsolidation did not trigger."
    };
  }

  const top = response.results[0];
  if (!top || !inferredTimeStart || !inferredTimeEnd) {
    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action: "abstain",
      reason: "Reconsolidation could not resolve a day window from the weak answer."
    };
  }

  const canonicalKey = buildDaySummaryCanonicalKey(inferredTimeStart);
  const formattedDay = formatUtcDayLabel(inferredTimeStart);
  const topEventsRaw =
    typeof top.provenance?.metadata === "object" && top.provenance.metadata
      ? String((top.provenance.metadata as Record<string, unknown>).top_events ?? "")
      : "";
  const topEvents = topEventsRaw
    .split(/\s*,\s*/u)
    .map((item) => item.replace(/:\d+$/u, "").trim())
    .filter(Boolean);
  const humanSummary = topEvents.length > 0
    ? `Steve's day on ${formattedDay} included ${formatList(topEvents)}.`
    : `Steve's day on ${formattedDay} included ${top.content.replace(/^DAY rollup\s+/u, "").trim()}`;
  const daySummaryContent = normalizeSummaryContent(humanSummary);
  const sourceArtifactId = response.evidence.find((item) => item.artifactId)?.artifactId ?? top.artifactId ?? null;
  const sourceEpisodicId = await resolveSourceEpisodicId(input.namespaceId, sourceArtifactId, inferredTimeStart, inferredTimeEnd);

  return withTransaction(async (client) => {
    const existingResult = await client.query<{
      id: string;
      content_abstract: string;
    }>(
      `
        SELECT id, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [input.namespaceId, canonicalKey]
    );

    const existing = existingResult.rows[0];
    if (existing && normalizeSummaryContent(existing.content_abstract) === daySummaryContent) {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            source_episodic_id,
            reason,
            metadata
          )
          VALUES ($1, $2, $3, 'abstain', 'day_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          priorConfidence,
          existing.id,
          sourceEpisodicId,
          "An evidence-anchored day summary already existed with matching content.",
          JSON.stringify({
            run_id: runId,
            canonical_key: canonicalKey,
            inferred_time_start: inferredTimeStart,
            inferred_time_end: inferredTimeEnd
          })
        ]
      );

      return {
        runId,
        namespaceId: input.namespaceId,
        query: input.query,
        priorConfidence,
        action: "abstain",
        semanticMemoryId: existing.id,
        reason: "Matching day summary already existed."
      };
    }

    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.87, $3::timestamptz, NULL, 'active', true, $4::uuid, 'day_summary', $5, $6::jsonb, $7::jsonb, true)
        RETURNING id
      `,
      [
        input.namespaceId,
        daySummaryContent,
        inferredTimeStart,
        sourceEpisodicId,
        canonicalKey,
        JSON.stringify({
          query: input.query,
          day_start: inferredTimeStart,
          day_end: inferredTimeEnd
        }),
        JSON.stringify({
          source: "memory_reconsolidation",
          run_id: runId,
          trigger_confidence: priorConfidence,
          evidence_count: response.evidence.length,
          derived_from_memory_id: top.memoryId,
          derived_from_memory_type: top.memoryType,
          source_artifact_id: sourceArtifactId
        })
      ]
    );

    const semanticMemoryId = insertResult.rows[0]?.id;
    if (!semanticMemoryId) {
      throw new Error("Failed to create reconsolidated semantic day summary.");
    }

    let action: MemoryReconsolidationSummary["action"] = "add";
    let reason = "Added an evidence-anchored day summary semantic note after a weak day query.";

    if (existing) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2::timestamptz,
            status = 'superseded',
            superseded_by_id = $3::uuid
          WHERE id = $1
        `,
        [existing.id, inferredTimeStart, semanticMemoryId]
      );
      action = "supersede";
      reason = "Superseded an older reconsolidated day summary with stronger evidence-backed content.";
    }

    await client.query(
      `
        INSERT INTO memory_reconsolidation_events (
          namespace_id,
          query_text,
          trigger_confidence,
          action,
          target_memory_kind,
          semantic_memory_id,
          source_episodic_id,
          reason,
          metadata
        )
        VALUES ($1, $2, $3, $4, 'day_summary', $5::uuid, $6::uuid, $7, $8::jsonb)
      `,
      [
        input.namespaceId,
        input.query,
        priorConfidence,
        action,
        semanticMemoryId,
        sourceEpisodicId,
        reason,
        JSON.stringify({
          run_id: runId,
          canonical_key: canonicalKey,
          inferred_time_start: inferredTimeStart,
          inferred_time_end: inferredTimeEnd,
          evidence_count: response.evidence.length
        })
      ]
    );

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action,
      semanticMemoryId,
      reason
    };
  });
}
