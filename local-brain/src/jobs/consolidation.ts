import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import type { ConsolidationAction, ConsolidationDecision, JobRunContext } from "./types.js";

interface CandidateRow {
  readonly candidate_id: string;
  readonly namespace_id: string;
  readonly candidate_type: string;
  readonly content: string;
  readonly created_at: string;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_artifact_observation_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurred_at: string | null;
}

interface PreferenceStatement {
  readonly polarity: "like" | "dislike";
  readonly target: string;
  readonly canonicalKey: string;
}

export interface ConsolidationRunSummary {
  readonly context: JobRunContext;
  readonly scannedCandidates: number;
  readonly processedCandidates: number;
  readonly promotedMemories: number;
  readonly supersededMemories: number;
  readonly decisions: readonly ConsolidationDecision[];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizePreferenceTarget(value: string): string {
  return normalizeWhitespace(
    value
      .toLowerCase()
      .replace(/\b(?:that|the|a|an)\b/gu, " ")
      .replace(/\b(?:instead|now|today|currently|really|very|said)\b/gu, " ")
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
  );
}

function buildCanonicalPreferenceKey(target: string): string {
  return `preference:${target}`;
}

function extractPreferenceStatements(content: string): PreferenceStatement[] {
  const statements: PreferenceStatement[] = [];
  const normalizedContent = content.replace(
    /\band\s+(?=(?:(?:i|user)\s+)?(?:prefer|like|love|enjoy|hate|dislike)\b)/giu,
    ". "
  );
  const clauses = normalizedContent
    .split(/[.!?\n]+/u)
    .map((clause) => normalizeWhitespace(clause))
    .filter(Boolean);

  for (const clause of clauses) {
    const dontLikeMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:do\s+not|don't)\s+like\s+(.+)$/iu);
    if (dontLikeMatch) {
      const target = normalizePreferenceTarget(dontLikeMatch[1] ?? "");
      if (target) {
        statements.push({
          polarity: "dislike",
          target,
          canonicalKey: buildCanonicalPreferenceKey(target)
        });
      }
      continue;
    }

    const negativeMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:said\s+that\s+)?(?:really\s+)?(?:hate|dislike)\s+(.+)$/iu);
    if (negativeMatch) {
      const target = normalizePreferenceTarget(negativeMatch[1] ?? "");
      if (target) {
        statements.push({
          polarity: "dislike",
          target,
          canonicalKey: buildCanonicalPreferenceKey(target)
        });
      }
      continue;
    }

    const positiveMatch = clause.match(/\b(?:(?:i|user)\s+)?(?:said\s+that\s+)?(?:really\s+)?(?:like|love|prefer|enjoy)\s+(.+)$/iu);
    if (positiveMatch) {
      const target = normalizePreferenceTarget(positiveMatch[1] ?? "");
      if (target) {
        statements.push({
          polarity: "like",
          target,
          canonicalKey: buildCanonicalPreferenceKey(target)
        });
      }
    }
  }

  return statements;
}

function buildDecision(
  action: ConsolidationAction,
  reason: string,
  confidence: number,
  supersedesId?: string
): ConsolidationDecision {
  return {
    action,
    reason,
    confidence,
    supersedesId
  };
}

async function markCandidate(
  client: PoolClient,
  options: {
    readonly candidateId: string;
    readonly status: "accepted" | "rejected" | "superseded";
    readonly decisionReason: string;
    readonly canonicalKey?: string;
    readonly normalizedValue?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      UPDATE memory_candidates
      SET
        status = $2,
        processed_at = now(),
        decision_reason = $3,
        canonical_key = COALESCE($4, canonical_key),
        normalized_value = CASE
          WHEN $5::jsonb IS NULL THEN normalized_value
          ELSE $5::jsonb
        END
      WHERE id = $1
    `,
    [
      options.candidateId,
      options.status,
      options.decisionReason,
      options.canonicalKey ?? null,
      options.normalizedValue ? JSON.stringify(options.normalizedValue) : null
    ]
  );
}

async function upsertProceduralPreference(
  client: PoolClient,
  options: {
    readonly namespaceId: string;
    readonly canonicalKey: string;
    readonly target: string;
    readonly polarity: "like" | "dislike";
    readonly occurredAt: string;
    readonly sourceMemoryId: string | null;
    readonly semanticId: string;
  }
): Promise<void> {
  const activeState = await client.query<{
    id: string;
    version: number;
  }>(
    `
      SELECT id, version
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'preference'
        AND state_key = $2
        AND valid_until IS NULL
      ORDER BY version DESC
      LIMIT 1
    `,
    [options.namespaceId, options.canonicalKey]
  );

  const activeRow = activeState.rows[0];
  if (activeRow) {
    await client.query(
      `
        UPDATE procedural_memory
        SET valid_until = $2
        WHERE id = $1
      `,
      [activeRow.id, options.occurredAt]
    );
  }

  const nextVersion = (activeRow?.version ?? 0) + 1;
  await client.query(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, 'preference', $2, $3::jsonb, $4, $5, $5, NULL, $6, $7::jsonb)
    `,
    [
      options.namespaceId,
      options.canonicalKey,
      JSON.stringify({
        target: options.target,
        polarity: options.polarity,
        semantic_memory_id: options.semanticId,
        source_memory_id: options.sourceMemoryId
      }),
      nextVersion,
      options.occurredAt,
      activeRow?.id ?? null,
      JSON.stringify({
        source: "candidate_consolidation"
      })
    ]
  );
}

async function promotePreferenceCandidate(
  client: PoolClient,
  candidate: CandidateRow
): Promise<{
  readonly decisions: ConsolidationDecision[];
  readonly promotedCount: number;
  readonly supersededCount: number;
}> {
  const occurredAt = candidate.occurred_at ?? candidate.created_at;
  const statements = extractPreferenceStatements(candidate.content);

  if (statements.length === 0) {
    await markCandidate(client, {
      candidateId: candidate.candidate_id,
      status: "rejected",
      decisionReason: "No deterministic preference statement could be parsed."
    });

    return {
      decisions: [buildDecision("IGNORE", "No deterministic preference statement found.", 0.2)],
      promotedCount: 0,
      supersededCount: 0
    };
  }

  const decisions: ConsolidationDecision[] = [];
  let promotedCount = 0;
  let supersededCount = 0;
  let lastCanonicalKey: string | undefined;
  let lastNormalizedValue: Record<string, unknown> | undefined;

  for (const statement of statements) {
    lastCanonicalKey = statement.canonicalKey;
    lastNormalizedValue = {
      target: statement.target,
      polarity: statement.polarity
    };

    const activeRows = await client.query<{
      id: string;
      normalized_value: Record<string, unknown>;
    }>(
      `
        SELECT id, normalized_value
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [candidate.namespace_id, statement.canonicalKey]
    );

    const activeRow = activeRows.rows[0];
    const activePolarity =
      typeof activeRow?.normalized_value?.polarity === "string"
        ? activeRow.normalized_value.polarity
        : null;

    if (activeRow && activePolarity === statement.polarity) {
      await client.query(
        `
          UPDATE semantic_memory
          SET metadata = semantic_memory.metadata || $2::jsonb
          WHERE id = $1
        `,
        [
          activeRow.id,
          JSON.stringify({
            last_confirmed_at: occurredAt,
            last_candidate_id: candidate.candidate_id
          })
        ]
      );

      decisions.push(buildDecision("UPDATE", `Reinforced active preference ${statement.canonicalKey}.`, 0.72, activeRow.id));
      continue;
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
          source_episodic_id,
          source_chunk_id,
          source_artifact_observation_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata
        )
        VALUES ($1, $2, $3, $4, NULL, 'active', $5, $6, $7, 'preference', $8, $9::jsonb, $10::jsonb)
        RETURNING id
      `,
      [
        candidate.namespace_id,
        `User ${statement.polarity === "like" ? "likes" : "dislikes"} ${statement.target}.`,
        0.82,
        occurredAt,
        candidate.source_memory_id,
        candidate.source_chunk_id,
        candidate.source_artifact_observation_id,
        statement.canonicalKey,
        JSON.stringify(lastNormalizedValue),
        JSON.stringify({
          source: "candidate_consolidation",
          candidate_id: candidate.candidate_id
        })
      ]
    );

    const semanticId = insertResult.rows[0]?.id;
    if (!semanticId) {
      throw new Error("Failed to insert semantic preference memory");
    }

    promotedCount += 1;

    if (activeRow) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2,
            status = 'superseded',
            superseded_by_id = $3
          WHERE id = $1
        `,
        [activeRow.id, occurredAt, semanticId]
      );

      supersededCount += 1;
      decisions.push(
        buildDecision("SUPERSEDE", `Superseded ${statement.canonicalKey} with new preference evidence.`, 0.88, activeRow.id)
      );
    } else {
      decisions.push(buildDecision("ADD", `Added new preference ${statement.canonicalKey}.`, 0.84));
    }

    await upsertProceduralPreference(client, {
      namespaceId: candidate.namespace_id,
      canonicalKey: statement.canonicalKey,
      target: statement.target,
      polarity: statement.polarity,
      occurredAt,
      sourceMemoryId: candidate.source_memory_id,
      semanticId
    });
  }

  await markCandidate(client, {
    candidateId: candidate.candidate_id,
    status: "accepted",
    decisionReason: `Processed ${statements.length} deterministic preference statement(s).`,
    canonicalKey: lastCanonicalKey,
    normalizedValue: lastNormalizedValue
  });

  return {
    decisions,
    promotedCount,
    supersededCount
  };
}

export async function runCandidateConsolidation(
  namespaceId: string,
  limit = 50
): Promise<ConsolidationRunSummary> {
  const context: JobRunContext = {
    runId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  return withTransaction(async (client) => {
    const candidates = await client.query<CandidateRow>(
      `
        SELECT
          mc.id AS candidate_id,
          mc.namespace_id,
          mc.candidate_type,
          mc.content,
          mc.created_at,
          mc.source_memory_id,
          mc.source_chunk_id,
          mc.source_artifact_observation_id,
          mc.metadata,
          em.occurred_at
        FROM memory_candidates mc
        LEFT JOIN episodic_memory em ON em.id = mc.source_memory_id
        WHERE mc.namespace_id = $1
          AND mc.status = 'pending'
          AND mc.candidate_type = 'semantic_preference'
        ORDER BY COALESCE(em.occurred_at, mc.created_at) ASC, mc.created_at ASC
        LIMIT $2
      `,
      [namespaceId, Math.max(1, limit)]
    );

    const decisions: ConsolidationDecision[] = [];
    let processedCandidates = 0;
    let promotedMemories = 0;
    let supersededMemories = 0;

    for (const candidate of candidates.rows) {
      const result = await promotePreferenceCandidate(client, candidate);
      processedCandidates += 1;
      promotedMemories += result.promotedCount;
      supersededMemories += result.supersededCount;
      decisions.push(...result.decisions);
    }

    return {
      context,
      scannedCandidates: candidates.rowCount ?? 0,
      processedCandidates,
      promotedMemories,
      supersededMemories,
      decisions
    };
  });
}
