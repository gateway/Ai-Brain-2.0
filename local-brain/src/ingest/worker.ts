import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { registerArtifactObservation, toArtifactRecord } from "../artifacts/registry.js";
import { stageNarrativeClaims } from "../relationships/narrative.js";
import { splitIntoFragments, splitIntoScenes } from "./fragment.js";
import type { CandidateMemoryWrite, IngestRequest, IngestResult } from "./types.js";

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function buildCandidateWrites(content: string, metadata: Record<string, unknown>): CandidateMemoryWrite[] {
  const writes: CandidateMemoryWrite[] = [];
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((value): value is string => typeof value === "string") : [];
  const lowered = content.toLowerCase();

  if (tags.includes("preference") || /\b(?:prefer|likes?|hates?|always|never)\b/u.test(lowered)) {
    writes.push({
      candidateType: "semantic_preference",
      content,
      confidence: 0.75,
      metadata
    });
  }

  if (tags.includes("project")) {
    writes.push({
      candidateType: "procedural_project_state",
      content,
      confidence: 0.6,
      metadata
    });
  }

  if (tags.includes("travel")) {
    writes.push({
      candidateType: "semantic_event",
      content,
      confidence: 0.55,
      metadata
    });
  }

  if (writes.length === 0 && typeof metadata.importance_score === "number" && metadata.importance_score >= 0.55) {
    writes.push({
      candidateType: "semantic_note",
      content,
      confidence: 0.5,
      metadata
    });
  }

  return writes;
}

async function insertFragment(
  client: PoolClient,
  options: {
    readonly artifactId: string;
    readonly observationId: string;
    readonly namespaceId: string;
    readonly content: string;
    readonly fragmentIndex: number;
    readonly charStart?: number;
    readonly charEnd?: number;
    readonly occurredAt: string;
    readonly capturedAt: string;
    readonly metadata: Record<string, unknown>;
  }
): Promise<{
  episodicInserted: boolean;
  candidates: CandidateMemoryWrite[];
  sourceMemoryId?: string;
  sourceChunkId: string;
}> {
  const chunkResult = await client.query<{ id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id,
        artifact_observation_id,
        chunk_index,
        char_start,
        char_end,
        text_content,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (artifact_observation_id, chunk_index)
      DO UPDATE SET
        text_content = EXCLUDED.text_content,
        char_start = EXCLUDED.char_start,
        char_end = EXCLUDED.char_end,
        metadata = artifact_chunks.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [
      options.artifactId,
      options.observationId,
      options.fragmentIndex,
      options.charStart ?? null,
      options.charEnd ?? null,
      options.content,
      JSON.stringify(options.metadata)
    ]
  );

  const sourceChunkId = chunkResult.rows[0]?.id;
  if (!sourceChunkId) {
    throw new Error("Failed to insert artifact chunk");
  }

  const episodicResult = await client.query<{ id: string }>(
    `
      INSERT INTO episodic_memory (
        namespace_id,
        role,
        content,
        occurred_at,
        captured_at,
        artifact_id,
        artifact_observation_id,
        source_chunk_id,
        source_offset,
        token_count,
        metadata
      )
      VALUES ($1, 'import', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
      ON CONFLICT (artifact_observation_id, source_chunk_id, role)
      DO NOTHING
      RETURNING id
    `,
    [
      options.namespaceId,
      options.content,
      options.occurredAt,
      options.capturedAt,
      options.artifactId,
      options.observationId,
      sourceChunkId,
      JSON.stringify({
        char_start: options.charStart ?? null,
        char_end: options.charEnd ?? null
      }),
      options.content.split(/\s+/u).filter(Boolean).length,
      JSON.stringify(options.metadata)
    ]
  );

  let sourceMemoryId = episodicResult.rows[0]?.id;
  if (!sourceMemoryId) {
    const existing = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE artifact_observation_id = $1
          AND source_chunk_id = $2
          AND role = 'import'
        LIMIT 1
      `,
      [options.observationId, sourceChunkId]
    );

    sourceMemoryId = existing.rows[0]?.id;
  }

  if (sourceMemoryId) {
    await client.query(
      `
        INSERT INTO episodic_timeline (
          occurred_at,
          memory_id,
          namespace_id,
          session_id,
          role,
          content,
          captured_at,
          artifact_id,
          artifact_observation_id,
          source_chunk_id,
          source_offset,
          token_count,
          metadata
        )
        VALUES ($1, $2, $3, NULL, 'import', $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
        ON CONFLICT (occurred_at, memory_id)
        DO UPDATE SET
          namespace_id = EXCLUDED.namespace_id,
          content = EXCLUDED.content,
          captured_at = EXCLUDED.captured_at,
          artifact_id = EXCLUDED.artifact_id,
          artifact_observation_id = EXCLUDED.artifact_observation_id,
          source_chunk_id = EXCLUDED.source_chunk_id,
          source_offset = EXCLUDED.source_offset,
          token_count = EXCLUDED.token_count,
          metadata = EXCLUDED.metadata
      `,
      [
        options.occurredAt,
        sourceMemoryId,
        options.namespaceId,
        options.content,
        options.capturedAt,
        options.artifactId,
        options.observationId,
        sourceChunkId,
        JSON.stringify({
          char_start: options.charStart ?? null,
          char_end: options.charEnd ?? null
        }),
        options.content.split(/\s+/u).filter(Boolean).length,
        JSON.stringify(options.metadata)
      ]
    );
  }

  const candidateWrites = buildCandidateWrites(options.content, options.metadata);

  if (sourceMemoryId) {
    for (const candidate of candidateWrites) {
      await client.query(
        `
          INSERT INTO memory_candidates (
            namespace_id,
            source_memory_id,
            source_chunk_id,
            source_artifact_observation_id,
            candidate_type,
            content,
            confidence,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (source_memory_id, source_chunk_id, candidate_type, content)
          DO NOTHING
        `,
        [
          options.namespaceId,
          sourceMemoryId,
          sourceChunkId,
          options.observationId,
          candidate.candidateType,
          candidate.content,
          candidate.confidence ?? null,
          JSON.stringify(candidate.metadata ?? {})
        ]
      );
    }
  }

  return {
    episodicInserted: (episodicResult.rowCount ?? 0) > 0,
    candidates: candidateWrites,
    sourceMemoryId: sourceMemoryId ?? undefined,
    sourceChunkId
  };
}

export async function ingestArtifact(request: IngestRequest): Promise<IngestResult> {
  const inputUri = request.inputUri;

  if (!inputUri) {
    throw new Error("First implementation slice only supports file-backed ingestion via inputUri");
  }

  return withTransaction(async (client) => {
    const observation = await registerArtifactObservation(client, {
      namespaceId: request.namespaceId,
      sourceType: request.sourceType,
      inputUri,
      sourceChannel: request.sourceChannel,
      metadata: request.metadata
    });

    const normalizedText = normalizeText(observation.textContent);
    const scenes = splitIntoScenes(normalizedText, request.capturedAt);
    const fragments = splitIntoFragments(normalizedText, request.capturedAt);
    const artifact = toArtifactRecord({
      namespaceId: request.namespaceId,
      sourceType: request.sourceType,
      sourceChannel: request.sourceChannel,
      metadata: request.metadata,
      observation
    });

    if (!observation.hasTextContent || !normalizedText) {
      return {
        artifact,
        fragments: [],
        candidateWrites: [],
        episodicInsertCount: 0
      };
    }

    let episodicInsertCount = 0;
    const candidateWrites: CandidateMemoryWrite[] = [];
    const sceneSources = new Map<number, { sourceMemoryIds: string[]; sourceChunkIds: string[]; occurredAt: string }>();

    for (const fragment of fragments) {
      const metadata = {
        ...(request.metadata ?? {}),
        importance_score: fragment.importanceScore ?? null,
        tags: fragment.tags ?? [],
        source_type: request.sourceType
      };

      const inserted = await insertFragment(client, {
        artifactId: observation.artifactId,
        observationId: observation.observationId,
        namespaceId: request.namespaceId,
        content: fragment.text,
        fragmentIndex: fragment.fragmentIndex,
        charStart: fragment.charStart,
        charEnd: fragment.charEnd,
        occurredAt: fragment.occurredAt,
        capturedAt: request.capturedAt,
        metadata
      });

      if (inserted.episodicInserted) {
        episodicInsertCount += 1;
      }

      candidateWrites.push(...inserted.candidates);

      const bucket = sceneSources.get(fragment.sceneIndex) ?? {
        sourceMemoryIds: [],
        sourceChunkIds: [],
        occurredAt: fragment.occurredAt
      };

      if (inserted.sourceMemoryId) {
        bucket.sourceMemoryIds.push(inserted.sourceMemoryId);
      }
      bucket.sourceChunkIds.push(inserted.sourceChunkId);
      sceneSources.set(fragment.sceneIndex, bucket);
    }

    await stageNarrativeClaims(client, {
      namespaceId: request.namespaceId,
      artifactId: observation.artifactId,
      observationId: observation.observationId,
      capturedAt: request.capturedAt,
      scenes,
      sceneSources: scenes.map((scene) => ({
        sceneIndex: scene.sceneIndex,
        sourceMemoryIds: sceneSources.get(scene.sceneIndex)?.sourceMemoryIds ?? [],
        sourceChunkIds: sceneSources.get(scene.sceneIndex)?.sourceChunkIds ?? [],
        occurredAt: sceneSources.get(scene.sceneIndex)?.occurredAt ?? scene.occurredAt
      }))
    });

    return {
      artifact,
      fragments,
      candidateWrites,
      episodicInsertCount
    };
  });
}
