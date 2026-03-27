import type { PoolClient } from "pg";
import type { CandidateMemoryWrite } from "./types.js";

export function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizePersistedTimestamp(value: string, fallbackIso: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallbackIso;
  }
  const year = parsed.getUTCFullYear();
  if (year < 1900 || year > 2100) {
    return fallbackIso;
  }
  return parsed.toISOString();
}

export function deriveSalienceMetadata(content: string): Record<string, unknown> | null {
  const lowered = content.toLowerCase();
  const labels = new Set<string>();
  let sentimentScore = 0;
  let surpriseMagnitude = 0;

  if (/\b(frustrated|frustrating|annoyed|bothered|ghosted|angry)\b/u.test(lowered)) {
    labels.add("frustrated");
    sentimentScore -= 0.85;
  }

  if (/\b(excited|amazing|thrilled)\b/u.test(lowered)) {
    labels.add("excited");
    sentimentScore += 0.82;
  }

  if (/\b(surprising|surprised|surprise|realization|finally clicked)\b/u.test(lowered)) {
    labels.add("surprised");
    surpriseMagnitude = 0.9;
  }

  if (labels.size === 0 && surpriseMagnitude === 0) {
    return null;
  }

  return {
    salience_labels: [...labels],
    sentiment_score: Math.max(-1, Math.min(1, Math.round(sentimentScore * 1000) / 1000)),
    surprise_magnitude: surpriseMagnitude,
    is_surprise: surpriseMagnitude >= 0.8
  };
}

export function buildCandidateWrites(
  content: string,
  metadata: Record<string, unknown>,
  options?: {
    readonly disableCandidatePromotion?: boolean;
  }
): CandidateMemoryWrite[] {
  if (options?.disableCandidatePromotion) {
    return [];
  }

  const writes: CandidateMemoryWrite[] = [];
  const tags = Array.isArray(metadata.tags) ? metadata.tags.filter((value): value is string => typeof value === "string") : [];
  const lowered = content.toLowerCase();
  const firstPersonPreferenceCue =
    /\bi\b.{0,24}\b(?:prefer|like|love|enjoy|hate|dislike)\b/u.test(lowered) ||
    /\bmy\b.{0,24}\b(?:preference|preferences|favorite|favourite)\b/u.test(lowered) ||
    /\bmy\s+(?:personal\s+)?preferences?\b/u.test(lowered);
  const listPreferenceCue =
    /\b(?:favorite|favourite)\s+(?:movies?|films?|sports?|books?|foods?)\b/u.test(lowered) ||
    /\b(?:wants?\s+to\s+(?:watch|see)|watch\s*list)\b/u.test(lowered);
  const explicitSkillCue =
    /\b(?:self-taught|full-stack web developer|full-stack web development|photogrammetry specialist|drone \+ photogrammetry specialist|faa part 107|built expertise in|using stable diffusion|using comfyui|using deforum|using animatediff)\b/u.test(lowered) ||
    /\b(?:stable diffusion|comfyui|deforum|animatediff)\b/u.test(content);
  const explicitDecisionCue =
    /\b(?:i|we)\s+(?:decided|choose|chose)\s+to\b/u.test(lowered) ||
    /\bdecision\s*:/u.test(lowered);
  const explicitConstraintCue =
    /\b(?:always|never)\b/u.test(lowered) ||
    /\b(?:the\s+brain|this\s+brain|the\s+system|our\s+system)\s+should\b/u.test(lowered) ||
    /\bask\s+for\s+clarification\s+instead\s+of\s+guessing\b/u.test(lowered);
  const explicitStyleCue =
    /\bkeep\s+(?:responses?|replies?)\s+concise\b/u.test(lowered) ||
    /\b(?:prefers?|preferred)\s+concise\s+(?:responses?|replies?)\b/u.test(lowered) ||
    /\bask\s+notebooklm\s+first\b/u.test(lowered) ||
    /\bwipe\s+and\s+replay\s+the\s+(?:db|database)\b/u.test(lowered) ||
    /\bprefer\s+natural-?language\s+queryability\b/u.test(lowered) ||
    /\bnatural-?language\s+queryability\s+matters\b/u.test(lowered);
  const explicitGoalCue =
    /\b(?:that'?s|that is|my|our|current)\s+goal\s*:?\s+/u.test(lowered) ||
    /\bgoal\s*:/u.test(lowered);
  const explicitPlanCue =
    /\bplan\s*:/u.test(lowered) ||
    (/\b(?:i|we)\s+(?:am|are|'m|'re)\s+going\s+to\b/u.test(lowered) &&
      /\b(?:conference|trip|launch|meeting|event|visit|move)\b/u.test(lowered)) ||
    /\b(?:i|we)\s+will\s+(?:go|visit|launch|meet)\b/u.test(lowered);
  const explicitBeliefCue =
    /\b(?:i|we)\s+(?:now\s+)?believe\b/u.test(lowered) ||
    /\b(?:my|our)\s+(?:stance|opinion)\s+on\b/u.test(lowered) ||
    /\bin\s+my\s+view\b/u.test(lowered);

  if (firstPersonPreferenceCue || listPreferenceCue) {
    writes.push({
      candidateType: "semantic_preference",
      content,
      confidence: 0.75,
      metadata
    });
  }

  if (explicitSkillCue) {
    writes.push({
      candidateType: "semantic_skill",
      content,
      confidence: 0.72,
      metadata
    });
  }

  if (explicitDecisionCue) {
    writes.push({
      candidateType: "semantic_decision",
      content,
      confidence: 0.72,
      metadata
    });
  }

  if (explicitConstraintCue) {
    writes.push({
      candidateType: "semantic_constraint",
      content,
      confidence: 0.72,
      metadata
    });
  }

  if (explicitStyleCue) {
    writes.push({
      candidateType: "semantic_style_spec",
      content,
      confidence: 0.73,
      metadata
    });
  }

  if (explicitGoalCue) {
    writes.push({
      candidateType: "semantic_goal",
      content,
      confidence: 0.74,
      metadata
    });
  }

  if (explicitPlanCue) {
    writes.push({
      candidateType: "semantic_plan",
      content,
      confidence: 0.72,
      metadata
    });
  }

  if (explicitBeliefCue) {
    writes.push({
      candidateType: "semantic_belief",
      content,
      confidence: 0.72,
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

export async function insertFragment(
  client: PoolClient,
  options: {
    readonly artifactId: string;
    readonly observationId: string;
    readonly namespaceId: string;
    readonly sessionId?: string;
    readonly content: string;
    readonly fragmentIndex: number;
    readonly charStart?: number;
    readonly charEnd?: number;
    readonly occurredAt: string;
    readonly capturedAt: string;
    readonly metadata: Record<string, unknown>;
    readonly disableCandidatePromotion?: boolean;
  }
): Promise<{
  episodicInserted: boolean;
  candidates: CandidateMemoryWrite[];
  sourceMemoryId?: string;
  sourceChunkId: string;
}> {
  const safeCapturedAt = normalizePersistedTimestamp(options.capturedAt, new Date().toISOString());
  const safeOccurredAt = normalizePersistedTimestamp(options.occurredAt, safeCapturedAt);
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
        session_id,
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
      VALUES ($1, $2, 'import', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
      ON CONFLICT (occurred_at, artifact_observation_id, source_chunk_id, role)
      DO NOTHING
      RETURNING id
    `,
    [
      options.namespaceId,
      options.sessionId ?? null,
      options.content,
      safeOccurredAt,
      safeCapturedAt,
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

  const candidateWrites = buildCandidateWrites(options.content, options.metadata, {
    disableCandidatePromotion: options.disableCandidatePromotion
  });

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
          ON CONFLICT ON CONSTRAINT memory_candidates_namespace_source_memory_id_source_chunk_key
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
