import type { PoolClient } from "pg";
import { queryRows } from "../db/client.js";
import type { RecallResult } from "../types.js";

export type GraphMemoryType = Extract<
  RecallResult["memoryType"],
  | "episodic_memory"
  | "semantic_memory"
  | "procedural_memory"
  | "relationship_memory"
  | "narrative_event"
  | "artifact_derivation"
  | "temporal_nodes"
>;

export type GraphEdgeType = "support" | "entity_link" | "relationship_link" | "supersedes" | "co_retrieval";

type Queryable = Pick<PoolClient, "query">;

interface UpsertGraphEdgeInput {
  readonly namespaceId: string;
  readonly sourceMemoryId: string;
  readonly sourceMemoryType: GraphMemoryType;
  readonly targetMemoryId: string;
  readonly targetMemoryType: GraphMemoryType;
  readonly edgeType: GraphEdgeType;
  readonly weight?: number;
  readonly metadata?: Record<string, unknown>;
}

function clampWeight(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0.05, Math.min(5, Number(value)));
}

export async function upsertMemoryGraphEdge(client: Queryable, input: UpsertGraphEdgeInput): Promise<void> {
  if (
    input.sourceMemoryId === input.targetMemoryId &&
    input.sourceMemoryType === input.targetMemoryType &&
    input.edgeType !== "co_retrieval"
  ) {
    return;
  }

  await client.query(
    `
      INSERT INTO memory_graph_edges (
        namespace_id,
        source_memory_id,
        source_memory_type,
        target_memory_id,
        target_memory_type,
        edge_type,
        weight,
        metadata,
        last_reinforced_at
      )
      VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::jsonb, now())
      ON CONFLICT (
        namespace_id,
        source_memory_id,
        source_memory_type,
        target_memory_id,
        target_memory_type,
        edge_type
      )
      DO UPDATE
      SET
        weight = GREATEST(memory_graph_edges.weight, EXCLUDED.weight),
        metadata = memory_graph_edges.metadata || EXCLUDED.metadata,
        last_reinforced_at = now()
    `,
    [
      input.namespaceId,
      input.sourceMemoryId,
      input.sourceMemoryType,
      input.targetMemoryId,
      input.targetMemoryType,
      input.edgeType,
      clampWeight(input.weight, 1),
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

export async function linkDerivedProfileSnapshot(
  client: Queryable,
  input: {
    readonly namespaceId: string;
    readonly semanticMemoryId: string;
    readonly sourceEpisodicId: string | null;
    readonly supportProceduralIds: readonly string[];
    readonly relationshipMemoryId?: string | null;
    readonly supersedesSemanticId?: string | null;
    readonly profileKind: string;
  }
): Promise<void> {
  if (input.sourceEpisodicId) {
    await upsertMemoryGraphEdge(client, {
      namespaceId: input.namespaceId,
      sourceMemoryId: input.semanticMemoryId,
      sourceMemoryType: "semantic_memory",
      targetMemoryId: input.sourceEpisodicId,
      targetMemoryType: "episodic_memory",
      edgeType: "support",
      weight: 0.96,
      metadata: {
        source_family: "profile_summary",
        profile_kind: input.profileKind
      }
    });
  }

  for (const proceduralId of input.supportProceduralIds) {
    await upsertMemoryGraphEdge(client, {
      namespaceId: input.namespaceId,
      sourceMemoryId: input.semanticMemoryId,
      sourceMemoryType: "semantic_memory",
      targetMemoryId: proceduralId,
      targetMemoryType: "procedural_memory",
      edgeType: "support",
      weight: 0.93,
      metadata: {
        source_family: "profile_summary",
        profile_kind: input.profileKind
      }
    });
  }

  if (input.relationshipMemoryId) {
    await upsertMemoryGraphEdge(client, {
      namespaceId: input.namespaceId,
      sourceMemoryId: input.semanticMemoryId,
      sourceMemoryType: "semantic_memory",
      targetMemoryId: input.relationshipMemoryId,
      targetMemoryType: "relationship_memory",
      edgeType: "relationship_link",
      weight: 0.95,
      metadata: {
        source_family: "profile_summary",
        profile_kind: input.profileKind
      }
    });
  }

  if (input.supersedesSemanticId) {
    await upsertMemoryGraphEdge(client, {
      namespaceId: input.namespaceId,
      sourceMemoryId: input.semanticMemoryId,
      sourceMemoryType: "semantic_memory",
      targetMemoryId: input.supersedesSemanticId,
      targetMemoryType: "semantic_memory",
      edgeType: "supersedes",
      weight: 0.9,
      metadata: {
        source_family: "profile_summary",
        profile_kind: input.profileKind
      }
    });
  }
}

export async function recordCoRetrievalEdges(
  namespaceId: string,
  results: readonly RecallResult[],
  options: {
    readonly sufficiency: "supported" | "weak" | "missing" | "contradicted";
    readonly subjectMatch: "matched" | "mixed" | "mismatched" | "unknown";
    readonly query: string;
  }
): Promise<void> {
  if (options.sufficiency !== "supported" || options.subjectMatch === "mismatched") {
    return;
  }

  const graphable = results.filter((result): result is RecallResult & { memoryType: GraphMemoryType } =>
    [
      "episodic_memory",
      "semantic_memory",
      "procedural_memory",
      "relationship_memory",
      "narrative_event",
      "artifact_derivation",
      "temporal_nodes"
    ].includes(result.memoryType)
  );

  if (graphable.length < 2) {
    return;
  }

  const capped = graphable.slice(0, 6);
  for (let leftIndex = 0; leftIndex < capped.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < capped.length; rightIndex += 1) {
      const left = capped[leftIndex]!;
      const right = capped[rightIndex]!;
      await queryRows(
        `
          INSERT INTO memory_graph_edges (
            namespace_id,
            source_memory_id,
            source_memory_type,
            target_memory_id,
            target_memory_type,
            edge_type,
            weight,
            metadata,
            last_reinforced_at
          )
          VALUES
            ($1, $2::uuid, $3, $4::uuid, $5, 'co_retrieval', 0.55, $6::jsonb, now()),
            ($1, $4::uuid, $5, $2::uuid, $3, 'co_retrieval', 0.55, $6::jsonb, now())
          ON CONFLICT (
            namespace_id,
            source_memory_id,
            source_memory_type,
            target_memory_id,
            target_memory_type,
            edge_type
          )
          DO UPDATE
          SET
            weight = LEAST(memory_graph_edges.weight + 0.08, 2.5),
            metadata = memory_graph_edges.metadata || EXCLUDED.metadata,
            last_reinforced_at = now()
        `,
        [
          namespaceId,
          left.memoryId,
          left.memoryType,
          right.memoryId,
          right.memoryType,
          JSON.stringify({
            learned_from: "supported_query",
            query: options.query
          })
        ]
      );
    }
  }
}
