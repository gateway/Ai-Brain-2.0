import type { PoolClient } from "pg";
import { withTransaction } from "../db/client.js";
import { registerArtifactObservation, toArtifactRecord } from "../artifacts/registry.js";
import { upsertMemoryGraphEdge } from "../jobs/memory-graph.js";
import { stageNarrativeClaims } from "../relationships/narrative.js";
import type { ArtifactRecord, SourceType } from "../types.js";
import { attachAnswerableUnitsForClient } from "./answerable-units.js";
import { splitIntoFragments, splitIntoScenes } from "./fragment.js";
import { deriveSalienceMetadata, insertFragment, normalizeText } from "./persist.js";
import { promoteTranscriptArtifactForClient } from "./transcript.js";
import type { CandidateMemoryWrite, IngestRequest, IngestResult } from "./types.js";

interface ConversationTurn {
  readonly turnIndex: number;
  readonly speaker: string;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
}

interface ConversationUnit {
  readonly unitIndex: number;
  readonly content: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly turnStartIndex: number;
  readonly turnEndIndex: number;
  readonly speakerNames: readonly string[];
}

interface TopicSegment {
  readonly segmentIndex: number;
  readonly topicLabel: string;
  readonly topicTerms: readonly string[];
  readonly content: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly turnStartIndex: number;
  readonly turnEndIndex: number;
  readonly speakerNames: readonly string[];
}

interface ParticipantBoundDerivation {
  readonly derivationIndex: number;
  readonly speakerName: string;
  readonly participantNames: readonly string[];
  readonly content: string;
  readonly sourceSentenceText: string;
  readonly promptSpeakerName?: string;
  readonly promptText?: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly turnIndex: number;
}

const TOPIC_SEGMENT_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "they",
  "this",
  "to",
  "too",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "who",
  "with",
  "would",
  "you",
  "your"
]);

const TOPIC_SEGMENT_SURPRISE_CUE =
  /\b(?:actually|anyway|but|changed|decided|however|instead|later|meanwhile|suddenly|surprised|turns out|unexpectedly)\b/iu;

interface CommunitySummary {
  readonly summaryIndex: number;
  readonly content: string;
  readonly speakerNames: readonly string[];
  readonly topicTerms: readonly string[];
  readonly topicKeys: readonly string[];
  readonly segmentIndexes: readonly number[];
}

function canonicalizeConversationSpeaker(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/gu, " ")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractConversationTurns(normalizedText: string): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const lines = normalizedText.split("\n");
  let cursor = 0;

  for (const rawLine of lines) {
    const lineStart = cursor;
    cursor += rawLine.length + 1;

    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^(Captured|Conversation between|Namespace intent|Source channel)\s*:/iu.test(line)) {
      continue;
    }

    const match = line.match(/^([^:\n]{2,80}):\s+(.+)$/u);
    if (!match) {
      continue;
    }

    const speaker = canonicalizeConversationSpeaker(match[1] ?? "");
    const text = (match[2] ?? "").trim();
    if (!speaker || !text) {
      continue;
    }

    const trimmedOffset = rawLine.indexOf(line);
    const safeStart = lineStart + Math.max(0, trimmedOffset);
    turns.push({
      turnIndex: turns.length,
      speaker,
      text,
      charStart: safeStart,
      charEnd: safeStart + line.length
    });
  }

  return turns;
}

function buildLosslessConversationUnits(turns: readonly ConversationTurn[]): readonly ConversationUnit[] {
  if (turns.length < 3) {
    return [];
  }

  const units: ConversationUnit[] = [];
  const maxTurnsPerUnit = 4;
  const stride = 2;

  for (let start = 0; start < turns.length; start += stride) {
    const window = turns.slice(start, start + maxTurnsPerUnit);
    if (window.length < 3) {
      continue;
    }

    const speakerNames = [...new Set(window.map((turn) => turn.speaker))];
    if (speakerNames.length < 2) {
      continue;
    }

    const first = window[0];
    const last = window[window.length - 1];
    const content = [
      `Conversation unit between ${speakerNames.join(" and ")}.`,
      ...window.map((turn) => `${turn.speaker}: ${turn.text}`)
    ].join("\n");

    units.push({
      unitIndex: units.length,
      content,
      charStart: first.charStart,
      charEnd: last.charEnd,
      turnStartIndex: first.turnIndex,
      turnEndIndex: last.turnIndex,
      speakerNames
    });
  }

  return units;
}

function topicTermsForTurn(text: string, speaker: string): readonly string[] {
  const speakerTerms = speaker
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/gu) ?? [];
  return [...new Set(
    tokens.filter((token) =>
      token.length >= 4 &&
      !TOPIC_SEGMENT_STOP_WORDS.has(token) &&
      !speakerTerms.includes(token) &&
      !/^\d+$/.test(token)
    )
  )];
}

function sharedTopicTermCount(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let count = 0;
  for (const term of left) {
    if (rightSet.has(term)) {
      count += 1;
    }
  }
  return count;
}

function buildTopicLabel(turns: readonly ConversationTurn[]): { readonly label: string; readonly terms: readonly string[] } | null {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    for (const term of topicTermsForTurn(turn.text, turn.speaker)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }

  const rankedTerms = [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([term]) => term)
    .slice(0, 4);

  if (rankedTerms.length === 0) {
    return null;
  }

  return {
    label: rankedTerms.slice(0, 3).join(", "),
    terms: rankedTerms
  };
}

function buildTopicSegments(turns: readonly ConversationTurn[]): readonly TopicSegment[] {
  if (turns.length < 2) {
    return [];
  }

  const segments: TopicSegment[] = [];
  let current: ConversationTurn[] = [];
  let currentTerms: string[] = [];

  const flush = (): void => {
    if (current.length < 2) {
      current = [];
      currentTerms = [];
      return;
    }
    const label = buildTopicLabel(current);
    if (!label) {
      current = [];
      currentTerms = [];
      return;
    }

    const first = current[0]!;
    const last = current[current.length - 1]!;
    const speakerNames = [...new Set(current.map((turn) => turn.speaker))];
    segments.push({
      segmentIndex: segments.length,
      topicLabel: label.label,
      topicTerms: label.terms,
      content: [
        `Topic segment about ${label.label}.`,
        ...current.map((turn) => `${turn.speaker}: ${turn.text}`)
      ].join("\n"),
      charStart: first.charStart,
      charEnd: last.charEnd,
      turnStartIndex: first.turnIndex,
      turnEndIndex: last.turnIndex,
      speakerNames
    });

    current = [];
    currentTerms = [];
  };

  for (const turn of turns) {
    const turnTerms = topicTermsForTurn(turn.text, turn.speaker);
    if (current.length === 0) {
      current = [turn];
      currentTerms = [...turnTerms];
      continue;
    }

    const overlap = sharedTopicTermCount(currentTerms, turnTerms);
    const shouldSplit =
      current.length >= 2 &&
      (
        (currentTerms.length > 0 && turnTerms.length > 0 && overlap === 0) ||
        TOPIC_SEGMENT_SURPRISE_CUE.test(turn.text)
      );

    if (shouldSplit) {
      flush();
      current = [turn];
      currentTerms = [...turnTerms];
      continue;
    }

    current.push(turn);
    currentTerms = [...new Set([...currentTerms, ...turnTerms])];
  }

  flush();
  return segments;
}

function buildCommunitySummaries(segments: readonly TopicSegment[]): readonly CommunitySummary[] {
  const grouped = new Map<string, TopicSegment[]>();
  for (const segment of segments) {
    const key = [...segment.speakerNames].sort((left, right) => left.localeCompare(right)).join("::");
    const bucket = grouped.get(key) ?? [];
    bucket.push(segment);
    grouped.set(key, bucket);
  }

  const summaries: CommunitySummary[] = [];
  for (const [key, group] of grouped.entries()) {
    if (group.length === 0) {
      continue;
    }
    const speakerNames = key.split("::").filter(Boolean);
    const topicCounts = new Map<string, number>();
    for (const segment of group) {
      for (const term of segment.topicTerms) {
        topicCounts.set(term, (topicCounts.get(term) ?? 0) + 1);
      }
    }
    const topicTerms = [...topicCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([term]) => term);
    if (topicTerms.length === 0) {
      continue;
    }
    const repeatedPhrase = group.length >= 2 ? "repeatedly discuss" : "discuss";
    summaries.push({
      summaryIndex: summaries.length,
      content: `Community summary for ${speakerNames.join(" and ")}: they ${repeatedPhrase} ${topicTerms.join(", ")} across grounded conversation segments.`,
      speakerNames,
      topicTerms,
      topicKeys: [...new Set(group.map((segment) => segment.topicTerms.slice(0, 3).join("_") || `segment_${segment.segmentIndex + 1}`))],
      segmentIndexes: group.map((segment) => segment.segmentIndex)
    });
  }

  return summaries;
}

function buildParticipantBoundDerivations(turns: readonly ConversationTurn[]): readonly ParticipantBoundDerivation[] {
  if (turns.length === 0) {
    return [];
  }

  const derivations: ParticipantBoundDerivation[] = [];
  for (const [index, turn] of turns.entries()) {
    const previousTurn = index > 0 ? turns[index - 1] : null;
    const includePreviousQuestion = previousTurn !== null && previousTurn.speaker !== turn.speaker && /\?\s*$/u.test(previousTurn.text);
    const participantNames = includePreviousQuestion
      ? [previousTurn!.speaker, turn.speaker]
      : [turn.speaker];
    const contentLines = [`Participant-bound turn for ${turn.speaker}.`];
    if (includePreviousQuestion && previousTurn) {
      contentLines.push(`${previousTurn.speaker}: ${previousTurn.text}`);
    }
    contentLines.push(`${turn.speaker}: ${turn.text}`);
    derivations.push({
      derivationIndex: derivations.length,
      speakerName: turn.speaker,
      participantNames,
      content: contentLines.join("\n"),
      sourceSentenceText: turn.text,
      promptSpeakerName: includePreviousQuestion && previousTurn ? previousTurn.speaker : undefined,
      promptText: includePreviousQuestion && previousTurn ? previousTurn.text : undefined,
      charStart: includePreviousQuestion && previousTurn ? previousTurn.charStart : turn.charStart,
      charEnd: turn.charEnd,
      turnIndex: turn.turnIndex
    });
  }

  return derivations;
}

async function attachConversationUnitsForClient(
  client: PoolClient,
  input: {
    readonly artifactId: string;
    readonly observationId: string;
    readonly normalizedText: string;
    readonly insertedFragments: readonly {
      readonly sourceChunkId: string;
      readonly charStart?: number;
      readonly charEnd?: number;
    }[];
    readonly metadata?: Record<string, unknown>;
  }
): Promise<number> {
  const turns = extractConversationTurns(input.normalizedText);
  const units = buildLosslessConversationUnits(turns);
  if (units.length === 0) {
    return 0;
  }

  await client.query(
    `
      DELETE FROM artifact_derivations
      WHERE artifact_observation_id = $1::uuid
        AND derivation_type = 'conversation_unit'
    `,
    [input.observationId]
  );

  for (const unit of units) {
    const overlappingChunkIds = input.insertedFragments
      .filter((fragment) => {
        if (typeof fragment.charStart !== "number" || typeof fragment.charEnd !== "number") {
          return false;
        }
        return fragment.charEnd > unit.charStart && fragment.charStart < unit.charEnd;
      })
      .map((fragment) => fragment.sourceChunkId);

    await client.query(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          content_text,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, 'conversation_unit', $3, $4::jsonb)
      `,
      [
        input.observationId,
        overlappingChunkIds[0] ?? null,
        unit.content,
        JSON.stringify({
          derivation_source: "lossless_conversation_unit_v1",
          speaker_names: unit.speakerNames,
          speaker_names_text: unit.speakerNames.join(" "),
          turn_start_index: unit.turnStartIndex,
          turn_end_index: unit.turnEndIndex,
          turn_count: unit.turnEndIndex - unit.turnStartIndex + 1,
          char_start: unit.charStart,
          char_end: unit.charEnd,
          source_chunk_ids: overlappingChunkIds,
          source_metadata: input.metadata ?? {}
        })
      ]
    );
  }

  return units.length;
}

async function attachParticipantBoundDerivationsForClient(
  client: PoolClient,
  input: {
    readonly observationId: string;
    readonly normalizedText: string;
    readonly insertedFragments: readonly {
      readonly sourceChunkId: string;
      readonly charStart?: number;
      readonly charEnd?: number;
    }[];
    readonly metadata?: Record<string, unknown>;
  }
): Promise<number> {
  const turns = extractConversationTurns(input.normalizedText);
  const derivations = buildParticipantBoundDerivations(turns);
  if (derivations.length === 0) {
    return 0;
  }

  await client.query(
    `
      DELETE FROM artifact_derivations
      WHERE artifact_observation_id = $1::uuid
        AND derivation_type = 'participant_turn'
    `,
    [input.observationId]
  );

  for (const derivation of derivations) {
    const overlappingChunkIds = input.insertedFragments
      .filter((fragment) => {
        if (typeof fragment.charStart !== "number" || typeof fragment.charEnd !== "number") {
          return false;
        }
        return fragment.charEnd > derivation.charStart && fragment.charStart < derivation.charEnd;
      })
      .map((fragment) => fragment.sourceChunkId);

    await client.query(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          content_text,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, 'participant_turn', $3, $4::jsonb)
      `,
      [
        input.observationId,
        overlappingChunkIds[0] ?? null,
        derivation.content,
        JSON.stringify({
          derivation_source: "participant_bound_turn_v1",
          primary_speaker_name: derivation.speakerName,
          participant_names: derivation.participantNames,
          participant_names_text: derivation.participantNames.join(" "),
          prompt_speaker_name: derivation.promptSpeakerName ?? null,
          prompt_text: derivation.promptText ?? null,
          source_sentence_text: derivation.sourceSentenceText,
          turn_index: derivation.turnIndex,
          char_start: derivation.charStart,
          char_end: derivation.charEnd,
          source_chunk_ids: overlappingChunkIds,
          source_metadata: input.metadata ?? {}
        })
      ]
    );
  }

  return derivations.length;
}

async function attachTopicSegmentsForClient(
  client: PoolClient,
  input: {
    readonly observationId: string;
    readonly normalizedText: string;
    readonly insertedFragments: readonly {
      readonly sourceChunkId: string;
      readonly charStart?: number;
      readonly charEnd?: number;
    }[];
    readonly metadata?: Record<string, unknown>;
  }
): Promise<number> {
  const turns = extractConversationTurns(input.normalizedText);
  const segments = buildTopicSegments(turns);
  if (segments.length === 0) {
    return 0;
  }

  await client.query(
    `
      DELETE FROM artifact_derivations
      WHERE artifact_observation_id = $1::uuid
        AND derivation_type = 'topic_segment'
    `,
    [input.observationId]
  );

  for (const segment of segments) {
    const overlappingChunkIds = input.insertedFragments
      .filter((fragment) => {
        if (typeof fragment.charStart !== "number" || typeof fragment.charEnd !== "number") {
          return false;
        }
        return fragment.charEnd > segment.charStart && fragment.charStart < segment.charEnd;
      })
      .map((fragment) => fragment.sourceChunkId);

    await client.query(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          content_text,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, 'topic_segment', $3, $4::jsonb)
      `,
      [
        input.observationId,
        overlappingChunkIds[0] ?? null,
        segment.content,
        JSON.stringify({
          derivation_source: "topic_segment_v1",
          topic_label: segment.topicLabel,
          topic_terms: segment.topicTerms,
          speaker_names: segment.speakerNames,
          speaker_names_text: segment.speakerNames.join(" "),
          participant_names: segment.speakerNames,
          participant_names_text: segment.speakerNames.join(" "),
          turn_start_index: segment.turnStartIndex,
          turn_end_index: segment.turnEndIndex,
          turn_count: segment.turnEndIndex - segment.turnStartIndex + 1,
          char_start: segment.charStart,
          char_end: segment.charEnd,
          source_chunk_ids: overlappingChunkIds,
          source_metadata: input.metadata ?? {}
        })
      ]
    );
  }

  return segments.length;
}

async function attachTopicAndCommunityDerivationsForClient(
  client: PoolClient,
  input: {
    readonly artifactId: string;
    readonly observationId: string;
    readonly namespaceId: string;
    readonly normalizedText: string;
    readonly insertedFragments: readonly {
      readonly sourceChunkId: string;
      readonly charStart?: number;
      readonly charEnd?: number;
    }[];
    readonly metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const turns = extractConversationTurns(input.normalizedText);
  const topicSegments = buildTopicSegments(turns);

  await client.query(
    `
      DELETE FROM artifact_derivations
      WHERE artifact_observation_id = $1::uuid
        AND derivation_type IN ('topic_segment', 'community_summary')
    `,
    [input.observationId]
  );

  if (topicSegments.length === 0) {
    return;
  }

  const conversationUnitRows = await client.query<{
    id: string;
    metadata: Record<string, unknown>;
  }>(
    `
      SELECT id::text AS id, metadata
      FROM artifact_derivations
      WHERE artifact_observation_id = $1::uuid
        AND derivation_type = 'conversation_unit'
    `,
    [input.observationId]
  );

  const topicSegmentRows: Array<{ readonly id: string; readonly segment: TopicSegment }> = [];
  for (const segment of topicSegments) {
    const overlappingChunkIds = input.insertedFragments
      .filter((fragment) => {
        if (typeof fragment.charStart !== "number" || typeof fragment.charEnd !== "number") {
          return false;
        }
        return fragment.charEnd > segment.charStart && fragment.charStart < segment.charEnd;
      })
      .map((fragment) => fragment.sourceChunkId);

    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          content_text,
          metadata
        )
        VALUES ($1::uuid, $2::uuid, 'topic_segment', $3, $4::jsonb)
        RETURNING id::text AS id
      `,
      [
        input.observationId,
        overlappingChunkIds[0] ?? null,
        segment.content,
        JSON.stringify({
          derivation_source: "topic_segment_v1",
          participant_names: segment.speakerNames,
          participant_names_text: segment.speakerNames.join(" "),
          topic_terms: segment.topicTerms,
          topic_label: segment.topicLabel,
          topic_key: segment.topicTerms.slice(0, 3).join("_") || `segment_${segment.segmentIndex + 1}`,
          summary_text: `Topic segment about ${segment.topicLabel}.`,
          turn_start_index: segment.turnStartIndex,
          turn_end_index: segment.turnEndIndex,
          char_start: segment.charStart,
          char_end: segment.charEnd,
          source_chunk_ids: overlappingChunkIds,
          source_metadata: input.metadata ?? {}
        })
      ]
    );
    const topicDerivationId = insertResult.rows[0]?.id;
    if (!topicDerivationId) {
      continue;
    }
    topicSegmentRows.push({ id: topicDerivationId, segment });

    for (const unitRow of conversationUnitRows.rows) {
      const unitMetadata = unitRow.metadata ?? {};
      const unitStart = typeof unitMetadata.char_start === "number" ? unitMetadata.char_start : null;
      const unitEnd = typeof unitMetadata.char_end === "number" ? unitMetadata.char_end : null;
      if (unitStart === null || unitEnd === null) {
        continue;
      }
      if (unitEnd <= segment.charStart || unitStart >= segment.charEnd) {
        continue;
      }
      await upsertMemoryGraphEdge(client, {
        namespaceId: input.namespaceId,
        sourceMemoryId: topicDerivationId,
        sourceMemoryType: "artifact_derivation",
        targetMemoryId: unitRow.id,
        targetMemoryType: "artifact_derivation",
        edgeType: "support",
        weight: 0.9,
        metadata: {
          derivation_type: "topic_segment",
          topic_key: segment.topicTerms.slice(0, 3).join("_") || `segment_${segment.segmentIndex + 1}`,
          participant_names: segment.speakerNames
        }
      });
    }
  }

  const communitySummaries = buildCommunitySummaries(topicSegments);
  for (const summary of communitySummaries) {
    const matchingTopicRows = topicSegmentRows.filter(({ segment }) => summary.segmentIndexes.includes(segment.segmentIndex));
    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO artifact_derivations (
          artifact_observation_id,
          source_chunk_id,
          derivation_type,
          content_text,
          metadata
        )
        VALUES ($1::uuid, NULL, 'community_summary', $2, $3::jsonb)
        RETURNING id::text AS id
      `,
      [
        input.observationId,
        summary.content,
        JSON.stringify({
          derivation_source: "community_summary_v1",
          participant_names: summary.speakerNames,
          participant_names_text: summary.speakerNames.join(" "),
          topic_terms: summary.topicTerms,
          topic_keys: summary.topicKeys,
          source_topic_ids: matchingTopicRows.map((row) => row.id),
          source_metadata: input.metadata ?? {}
        })
      ]
    );
    const communityDerivationId = insertResult.rows[0]?.id;
    if (!communityDerivationId) {
      continue;
    }
    for (const topicRow of matchingTopicRows) {
      await upsertMemoryGraphEdge(client, {
        namespaceId: input.namespaceId,
        sourceMemoryId: communityDerivationId,
        sourceMemoryType: "artifact_derivation",
        targetMemoryId: topicRow.id,
        targetMemoryType: "artifact_derivation",
        edgeType: "support",
        weight: 0.94,
        metadata: {
          derivation_type: "community_summary",
          topic_key: topicRow.segment.topicTerms.slice(0, 3).join("_") || `segment_${topicRow.segment.segmentIndex + 1}`,
          participant_names: summary.speakerNames
        }
      });
    }
  }
}

export async function ingestArtifact(request: IngestRequest): Promise<IngestResult> {
  return withTransaction(async (client) => {
    if (request.artifactId && request.observationId && typeof request.rawText === "string") {
      const artifactRows = await client.query<{
        artifact_id: string;
        observation_id: string;
        checksum_sha256: string;
        version: number;
        uri: string;
        mime_type: string | null;
      }>(
        `
          SELECT
            a.id AS artifact_id,
            ao.id AS observation_id,
            ao.checksum_sha256,
            ao.version,
            a.uri,
            a.mime_type
          FROM artifacts a
          JOIN artifact_observations ao ON ao.artifact_id = a.id
          WHERE a.id = $1::uuid
            AND ao.id = $2::uuid
          LIMIT 1
        `,
        [request.artifactId, request.observationId]
      );

      const row = artifactRows.rows[0];
      if (!row) {
        throw new Error(`Artifact observation ${request.observationId} was not found for artifact ${request.artifactId}`);
      }

      const artifact: ArtifactRecord = {
        artifactId: row.artifact_id,
        observationId: row.observation_id,
        namespaceId: request.namespaceId,
        sourceType: request.sourceType,
        uri: row.uri,
        checksumSha256: row.checksum_sha256,
        version: row.version,
        mimeType: row.mime_type ?? undefined,
        sourceChannel: request.sourceChannel,
        createdAt: new Date().toISOString(),
        metadata: request.metadata ?? {}
      };

      return ingestObservationTextForClient(client, {
        namespaceId: request.namespaceId,
        sessionId: request.sessionId,
        artifactId: row.artifact_id,
        observationId: row.observation_id,
        sourceType: request.sourceType,
        capturedAt: request.capturedAt,
        rawText: request.rawText,
        metadata: request.metadata,
        sourceChannel: request.sourceChannel,
        scenes: request.scenes,
        fragments: request.fragments,
        skipNarrativeClaims: request.skipNarrativeClaims,
        artifact
      });
    }

    const inputUri = request.inputUri;
    if (!inputUri) {
      throw new Error("ingestArtifact requires either inputUri or existing artifactId + observationId + rawText");
    }

    const observation = await registerArtifactObservation(client, {
      namespaceId: request.namespaceId,
      sourceType: request.sourceType,
      inputUri,
      capturedAt: request.capturedAt,
      sourceChannel: request.sourceChannel,
      metadata: request.metadata
    });

    const artifact = toArtifactRecord({
      namespaceId: request.namespaceId,
      sourceType: request.sourceType,
      sourceChannel: request.sourceChannel,
      metadata: request.metadata,
      observation
    });

    return ingestObservationTextForClient(client, {
      namespaceId: request.namespaceId,
      sessionId: request.sessionId,
      artifactId: observation.artifactId,
      observationId: observation.observationId,
      sourceType: request.sourceType,
      capturedAt: request.capturedAt,
      rawText: observation.textContent,
      metadata: request.metadata,
      sourceChannel: request.sourceChannel,
      scenes: request.scenes,
      fragments: request.fragments,
      skipNarrativeClaims: request.skipNarrativeClaims,
      artifact,
      hasTextContent: observation.hasTextContent
    });
  });
}

export async function ingestObservationTextForClient(
  client: PoolClient,
  request: {
    readonly namespaceId: string;
    readonly sessionId?: string;
    readonly artifactId: string;
    readonly observationId: string;
    readonly sourceType: string;
    readonly capturedAt: string;
    readonly rawText: string;
    readonly metadata?: Record<string, unknown>;
    readonly sourceChannel?: string;
    readonly scenes?: readonly import("../types.js").SceneRecord[];
    readonly fragments?: readonly import("../types.js").FragmentRecord[];
    readonly skipNarrativeClaims?: boolean;
    readonly artifact: ArtifactRecord;
    readonly hasTextContent?: boolean;
  }
): Promise<IngestResult> {
  if (request.sourceType === "transcript") {
    const promoted = await promoteTranscriptArtifactForClient(client, {
      namespaceId: request.namespaceId,
      artifactId: request.artifactId,
      observationId: request.observationId,
      capturedAt: request.capturedAt,
      transcriptText: request.rawText,
      transcriptMetadata: request.metadata,
      sessionId: request.sessionId,
      sourceType: request.sourceType as SourceType,
      sourceChannel: request.sourceChannel,
      baseMetadata: request.metadata,
      sourceUri: request.artifact.uri
    });

    return {
      artifact: request.artifact,
      fragments: [...promoted.fragments],
      candidateWrites: [...promoted.candidateWrites],
      episodicInsertCount: promoted.episodicInsertCount
    };
  }

  const normalizedText = normalizeText(request.rawText);
  const scenes = request.scenes ?? splitIntoScenes(normalizedText, request.capturedAt);
  const fragments = request.fragments ?? splitIntoFragments(normalizedText, request.capturedAt);

  if ((request.hasTextContent ?? true) === false || !normalizedText) {
    return {
      artifact: request.artifact,
      fragments: [],
      candidateWrites: [],
      episodicInsertCount: 0
    };
  }

  let episodicInsertCount = 0;
  const candidateWrites: CandidateMemoryWrite[] = [];
  const sceneSources = new Map<number, { sourceMemoryIds: string[]; sourceChunkIds: string[]; occurredAt: string }>();
  const insertedFragments: Array<{
    readonly sourceMemoryId?: string;
    readonly sourceChunkId: string;
    readonly content: string;
    readonly occurredAt: string;
    readonly charStart?: number;
    readonly charEnd?: number;
    readonly metadata?: Record<string, unknown>;
  }> = [];

  for (const fragment of fragments) {
      const metadata = {
        ...(request.metadata ?? {}),
        ...(fragment.metadata ?? {}),
        importance_score: fragment.importanceScore ?? null,
        tags: fragment.tags ?? [],
        source_type: request.sourceType,
        speaker_name: fragment.speaker ?? null,
        ...(deriveSalienceMetadata(fragment.text) ?? {})
      };

      const inserted = await insertFragment(client, {
        artifactId: request.artifactId,
        observationId: request.observationId,
        namespaceId: request.namespaceId,
        sessionId: request.sessionId,
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
      insertedFragments.push({
        sourceMemoryId: inserted.sourceMemoryId,
        sourceChunkId: inserted.sourceChunkId,
        content: fragment.text,
        occurredAt: fragment.occurredAt,
        charStart: fragment.charStart,
        charEnd: fragment.charEnd,
        metadata
      });
  }

  await attachConversationUnitsForClient(client, {
    artifactId: request.artifactId,
    observationId: request.observationId,
    normalizedText,
    insertedFragments,
    metadata: request.metadata
  });

  await attachParticipantBoundDerivationsForClient(client, {
    observationId: request.observationId,
    normalizedText,
    insertedFragments,
    metadata: request.metadata
  });

  await attachTopicSegmentsForClient(client, {
    observationId: request.observationId,
    normalizedText,
    insertedFragments,
    metadata: request.metadata
  });
  await attachTopicAndCommunityDerivationsForClient(client, {
    artifactId: request.artifactId,
    observationId: request.observationId,
    namespaceId: request.namespaceId,
    normalizedText,
    insertedFragments,
    metadata: request.metadata
  });

  await attachAnswerableUnitsForClient(client, {
    namespaceId: request.namespaceId,
    artifactId: request.artifactId,
    observationId: request.observationId,
    normalizedText,
    insertedFragments,
    metadata: request.metadata
  });

  if (!request.skipNarrativeClaims) {
    await stageNarrativeClaims(client, {
      namespaceId: request.namespaceId,
      artifactId: request.artifactId,
      observationId: request.observationId,
      capturedAt: request.capturedAt,
      scenes,
      sceneSources: scenes.map((scene) => ({
        sceneIndex: scene.sceneIndex,
        sourceMemoryIds: sceneSources.get(scene.sceneIndex)?.sourceMemoryIds ?? [],
        sourceChunkIds: sceneSources.get(scene.sceneIndex)?.sourceChunkIds ?? [],
        occurredAt: sceneSources.get(scene.sceneIndex)?.occurredAt ?? scene.occurredAt
      }))
    });
  }

  return {
    artifact: request.artifact,
    fragments: [...fragments],
    candidateWrites,
    episodicInsertCount
  };
}
