import type { PoolClient } from "pg";
import { splitIntoFragments } from "./fragment.js";
import { deriveSalienceMetadata, insertFragment, normalizeText } from "./persist.js";
import { stageNarrativeClaims } from "../relationships/narrative.js";
import { withTransaction } from "../db/client.js";
import type { CandidateMemoryWrite } from "./types.js";
import type { FragmentRecord, SceneRecord, SourceType } from "../types.js";

interface TranscriptSegmentLike {
  readonly id?: number;
  readonly start?: number;
  readonly end?: number;
  readonly text?: string;
  readonly speaker?: string;
  readonly confidence?: number;
}

interface TranscriptWordLike {
  readonly word?: string;
  readonly start?: number;
  readonly end?: number;
  readonly score?: number;
  readonly confidence?: number;
  readonly speaker?: string;
}

interface DecodedTranscriptPayload {
  readonly transcriptText: string;
  readonly language?: string;
  readonly durationSeconds?: number;
  readonly segments: readonly TranscriptSegmentLike[];
  readonly words: readonly TranscriptWordLike[];
  readonly sourceFilename?: string;
  readonly speakerHint?: string;
  readonly speakerUnknown: boolean;
}

interface NormalizedTranscriptUtterance {
  readonly utteranceIndex: number;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly occurredAt: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly confidence?: number;
  readonly speakerLabel?: string;
  readonly speakerName?: string;
  readonly speakerResolved: boolean;
  readonly speakerAmbiguous?: boolean;
  readonly charStart?: number;
  readonly charEnd?: number;
}

interface SpeakerAliasIndex {
  readonly canonicalByAlias: ReadonlyMap<string, string>;
  readonly ambiguousAliases: ReadonlySet<string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSpeakerLabel(raw: string | undefined): string | undefined {
  const value = asString(raw);
  if (!value) {
    return undefined;
  }

  if (/^speaker[:\s_-]*\d+$/iu.test(value)) {
    return undefined;
  }

  if (/^unknown$/iu.test(value)) {
    return undefined;
  }

  return value
    .split(/\s+/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeAliasKey(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

async function loadNamespaceSpeakerAliases(client: PoolClient, namespaceId: string): Promise<SpeakerAliasIndex> {
  const result = await client.query<{ alias: string; canonical_name: string }>(
    `
      SELECT ea.alias, e.canonical_name
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('self', 'person')
        AND e.merged_into_entity_id IS NULL
    `,
    [namespaceId]
  );

  const aliases = new Map<string, string>();
  const ambiguousAliases = new Set<string>();
  const registerAlias = (rawAlias: string, canonicalName: string) => {
    const normalizedAlias = normalizeAliasKey(rawAlias);
    if (!normalizedAlias) {
      return;
    }
    const existing = aliases.get(normalizedAlias);
    if (existing && existing !== canonicalName) {
      aliases.delete(normalizedAlias);
      ambiguousAliases.add(normalizedAlias);
      return;
    }
    if (!ambiguousAliases.has(normalizedAlias)) {
      aliases.set(normalizedAlias, canonicalName);
    }
  };
  for (const row of result.rows) {
    const canonicalName = asString(row.canonical_name);
    const alias = asString(row.alias);
    if (!canonicalName || !alias) {
      continue;
    }
    registerAlias(alias, canonicalName);
    registerAlias(canonicalName, canonicalName);
    const firstToken = canonicalName.split(/\s+/u)[0];
    if (firstToken) {
      registerAlias(firstToken, canonicalName);
    }
  }

  return {
    canonicalByAlias: aliases,
    ambiguousAliases
  };
}

function canonicalizeSpeakerName(label: string | undefined, aliasIndex: SpeakerAliasIndex): string | undefined {
  const normalized = normalizeSpeakerLabel(label);
  if (!normalized) {
    return undefined;
  }

  return aliasIndex.canonicalByAlias.get(normalizeAliasKey(normalized)) ?? normalized;
}

function isAmbiguousSpeakerAlias(label: string | undefined, aliasIndex: SpeakerAliasIndex): boolean {
  const normalized = normalizeSpeakerLabel(label);
  if (!normalized) {
    return false;
  }

  return aliasIndex.ambiguousAliases.has(normalizeAliasKey(normalized));
}

function inferSpeakerHint(input: {
  readonly metadata?: Record<string, unknown>;
  readonly sourceUri?: string;
}): string | undefined {
  const explicit =
    normalizeSpeakerLabel(asString(input.metadata?.primary_speaker_name)) ??
    normalizeSpeakerLabel(asString(input.metadata?.primary_speaker_label)) ??
    normalizeSpeakerLabel(asString(input.metadata?.speaker_name)) ??
    normalizeSpeakerLabel(asString(input.metadata?.speaker_identity)) ??
    normalizeSpeakerLabel(asString(input.metadata?.speaker_label));

  if (explicit) {
    return explicit;
  }

  const filename =
    asString(input.metadata?.source_filename) ??
    asString(input.metadata?.filename) ??
    (input.sourceUri ? input.sourceUri.split("/").pop() ?? undefined : undefined);

  if (!filename) {
    return undefined;
  }

  const match =
    filename.match(/(?:^|[_-])([a-z]+)[_-]speaking\b/i) ??
    filename.match(/(?:^|[_-])([a-z]+)[_-]voice\b/i) ??
    filename.match(/^([a-z]+)[._-]/i);

  const token = match?.[1];
  if (!token || token.length < 3) {
    return undefined;
  }

  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function parseTranscriptJson(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function decodeTranscriptPayload(input: {
  readonly rawText: string;
  readonly metadata?: Record<string, unknown>;
  readonly sourceUri?: string;
}): DecodedTranscriptPayload {
  const parsed = parseTranscriptJson(input.rawText);
  const metadata = input.metadata ?? {};
  const parsedMetadata = asRecord(parsed?.metadata);
  const transcriptText =
    normalizeText(
      asString(parsed?.text) ??
        asString(parsed?.transcript) ??
        asString(parsed?.content) ??
        input.rawText
    ) || "";

  const segments = Array.isArray(parsed?.segments)
    ? (parsed?.segments as readonly TranscriptSegmentLike[])
    : Array.isArray(metadata.segments)
      ? (metadata.segments as readonly TranscriptSegmentLike[])
      : [];
  const words = Array.isArray(parsed?.words)
    ? (parsed?.words as readonly TranscriptWordLike[])
    : Array.isArray(metadata.words)
      ? (metadata.words as readonly TranscriptWordLike[])
      : [];

  const speakerHint = inferSpeakerHint({
    metadata: {
      ...metadata,
      ...parsedMetadata
    },
    sourceUri: input.sourceUri
  });

  return {
    transcriptText,
    language:
      asString(parsed?.language) ??
      asString(metadata.language) ??
      asString(parsedMetadata.language),
    durationSeconds:
      asNumber(parsed?.duration_seconds) ??
      asNumber(parsed?.duration) ??
      asNumber(metadata.duration_seconds) ??
      asNumber(parsedMetadata.duration_seconds),
    segments,
    words,
    sourceFilename:
      asString(parsedMetadata.filename) ??
      asString(metadata.source_filename) ??
      asString(metadata.filename),
    speakerHint,
    speakerUnknown: !speakerHint && segments.every((segment) => !normalizeSpeakerLabel(segment.speaker))
  };
}

function toIsoWithOffset(capturedAt: string, offsetMs?: number): string {
  if (!offsetMs || !Number.isFinite(offsetMs)) {
    return capturedAt;
  }

  const base = new Date(capturedAt);
  if (Number.isNaN(base.getTime())) {
    return capturedAt;
  }

  return new Date(base.getTime() + Math.max(0, offsetMs)).toISOString();
}

function readWordConfidence(word: TranscriptWordLike): number | undefined {
  return asNumber(word.score) ?? asNumber(word.confidence);
}

function averageConfidence(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 1000) / 1000;
}

function buildWordTimedUtterances(
  transcriptText: string,
  words: readonly TranscriptWordLike[],
  capturedAt: string,
  speakerHint?: string
): readonly NormalizedTranscriptUtterance[] {
  const rawFragments = splitIntoFragments(transcriptText, capturedAt, capturedAt);
  let cursor = 0;

  return rawFragments.map((fragment, utteranceIndex) => {
    const tokenCount = fragment.text.split(/\s+/u).filter(Boolean).length;
    const utteranceWords = words.slice(cursor, cursor + tokenCount);
    cursor += tokenCount;
    const startMs =
      utteranceWords.length > 0 ? Math.round((asNumber(utteranceWords[0]?.start) ?? 0) * 1000) : undefined;
    const endMs =
      utteranceWords.length > 0
        ? Math.round((asNumber(utteranceWords[utteranceWords.length - 1]?.end) ?? asNumber(utteranceWords[utteranceWords.length - 1]?.start) ?? 0) * 1000)
        : undefined;

    return {
      utteranceIndex,
      rawText: fragment.text,
      normalizedText: fragment.text,
      occurredAt: toIsoWithOffset(capturedAt, startMs),
      startMs,
      endMs,
      confidence: averageConfidence(utteranceWords.map(readWordConfidence).filter((value): value is number => typeof value === "number")),
      speakerLabel: speakerHint,
      speakerName: speakerHint,
      speakerResolved: Boolean(speakerHint),
      charStart: fragment.charStart,
      charEnd: fragment.charEnd
    };
  });
}

function buildNormalizedUtterances(input: {
  readonly transcriptText: string;
  readonly capturedAt: string;
  readonly segments: readonly TranscriptSegmentLike[];
  readonly words: readonly TranscriptWordLike[];
  readonly speakerHint?: string;
}): readonly NormalizedTranscriptUtterance[] {
  const segments = input.segments
    .map((segment, index) => ({
      index,
      text: normalizeText(asString(segment.text) ?? ""),
      startMs: asNumber(segment.start) !== undefined ? Math.round((asNumber(segment.start) ?? 0) * 1000) : undefined,
      endMs: asNumber(segment.end) !== undefined ? Math.round((asNumber(segment.end) ?? 0) * 1000) : undefined,
      confidence: asNumber(segment.confidence),
      speakerLabel: normalizeSpeakerLabel(segment.speaker) ?? input.speakerHint
    }))
    .filter((segment) => segment.text);

  if (segments.length === 0) {
    return buildWordTimedUtterances(input.transcriptText, input.words, input.capturedAt, input.speakerHint);
  }

  let cursor = 0;
  return segments.map((segment) => {
    const charStart = input.transcriptText.toLowerCase().indexOf(segment.text.toLowerCase(), cursor);
    const safeStart = charStart >= 0 ? charStart : cursor;
    const charEnd = safeStart + segment.text.length;
    cursor = charEnd;

    return {
      utteranceIndex: segment.index,
      rawText: segment.text,
      normalizedText: segment.text,
      occurredAt: toIsoWithOffset(input.capturedAt, segment.startMs),
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: segment.confidence,
      speakerLabel: segment.speakerLabel,
      speakerName: segment.speakerLabel,
      speakerResolved: Boolean(segment.speakerLabel),
      charStart: safeStart,
      charEnd
    };
  });
}

function narrativizeFirstPerson(text: string, speakerName?: string): string {
  if (!speakerName) {
    return text;
  }

  return text
    .replace(/\bI['’]m\b/gu, `${speakerName} is`)
    .replace(/\bI['’]ve\b/gu, `${speakerName} has`)
    .replace(/\bI['’]d\b/gu, `${speakerName} would`)
    .replace(/\bI['’]ll\b/gu, `${speakerName} will`)
    .replace(/\bmy\b/giu, `${speakerName}'s`)
    .replace(/\bmine\b/giu, `${speakerName}'s`)
    .replace(/\bme\b/giu, speakerName)
    .replace(/\bI\b/gu, speakerName);
}

function shouldSkipClaimPromotion(utterances: readonly NormalizedTranscriptUtterance[]): boolean {
  return utterances.some((utterance) => !utterance.speakerResolved && /\b(I|I'm|I've|I'd|my|me)\b/u.test(utterance.rawText));
}

function buildTranscriptScenes(input: {
  readonly utterances: readonly NormalizedTranscriptUtterance[];
  readonly capturedAt: string;
  readonly claimPromotionSkipped: boolean;
}): readonly SceneRecord[] {
  return input.utterances.map((utterance) => ({
    sceneIndex: utterance.utteranceIndex,
    text: input.claimPromotionSkipped ? utterance.rawText : utterance.normalizedText,
    charStart: utterance.charStart,
    charEnd: utterance.charEnd,
    occurredAt: utterance.occurredAt,
    sceneKind: "paragraph",
    speaker: utterance.speakerLabel,
    utteranceIndex: utterance.utteranceIndex,
    utteranceStartMs: utterance.startMs,
    utteranceEndMs: utterance.endMs,
    transcriptConfidence: utterance.confidence,
    rawText: utterance.rawText,
    metadata: {
      transcript_utterance_index: utterance.utteranceIndex,
      speaker_label: utterance.speakerLabel ?? null,
      speaker_name: utterance.speakerName ?? utterance.speakerLabel ?? null,
      transcript_confidence: utterance.confidence ?? null,
      speaker_ambiguous: utterance.speakerAmbiguous ?? false,
      raw_text: utterance.rawText
    }
  }));
}

function nextChunkIndex(seed: number, utteranceIndex: number, localIndex: number): number {
  return seed + utteranceIndex * 100 + localIndex;
}

export async function promoteTranscriptArtifactForClient(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly artifactId: string;
    readonly observationId: string;
    readonly capturedAt: string;
    readonly transcriptText: string;
    readonly transcriptMetadata?: Record<string, unknown>;
    readonly sessionId?: string;
    readonly derivationId?: string;
    readonly sourceType?: SourceType;
    readonly sourceChannel?: string;
    readonly baseMetadata?: Record<string, unknown>;
    readonly sourceUri?: string;
  }
): Promise<{
  readonly fragments: readonly FragmentRecord[];
  readonly candidateWrites: readonly CandidateMemoryWrite[];
  readonly episodicInsertCount: number;
  readonly utteranceCount: number;
  readonly claimPromotionSkipped: boolean;
}> {
  const priorObservationRows = await client.query<{ artifact_observation_id: string }>(
    `
      SELECT id AS artifact_observation_id
      FROM artifact_observations
      WHERE artifact_id = $1::uuid
        AND id <> $2::uuid
    `,
    [input.artifactId, input.observationId]
  );

  const staleObservationIds = priorObservationRows.rows.map((row) => row.artifact_observation_id);
  if (staleObservationIds.length > 0) {
    await client.query(`DELETE FROM artifact_derivations WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM transcript_utterances WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM narrative_events WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM narrative_scenes WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM memory_candidates WHERE source_artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM episodic_memory WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
    await client.query(`DELETE FROM artifact_chunks WHERE artifact_observation_id = ANY($1::uuid[])`, [staleObservationIds]);
  }

  const decoded = decodeTranscriptPayload({
    rawText: input.transcriptText,
    metadata: input.transcriptMetadata,
    sourceUri: input.sourceUri
  });
  const speakerAliasIndex = await loadNamespaceSpeakerAliases(client, input.namespaceId);
  const canonicalSpeakerHint = isAmbiguousSpeakerAlias(decoded.speakerHint, speakerAliasIndex)
    ? undefined
    : canonicalizeSpeakerName(decoded.speakerHint, speakerAliasIndex);

  if (!decoded.transcriptText) {
    return {
      fragments: [],
      candidateWrites: [],
      episodicInsertCount: 0,
      utteranceCount: 0,
      claimPromotionSkipped: true
    };
  }

  const utterances = buildNormalizedUtterances({
    transcriptText: decoded.transcriptText,
    capturedAt: input.capturedAt,
    segments: decoded.segments,
    words: decoded.words,
    speakerHint: canonicalSpeakerHint
  }).map((utterance) => ({
    ...(() => {
      const normalizedSpeakerLabel = normalizeSpeakerLabel(utterance.speakerLabel);
      const speakerAmbiguous = isAmbiguousSpeakerAlias(normalizedSpeakerLabel, speakerAliasIndex);
      const speakerName = speakerAmbiguous
        ? (normalizedSpeakerLabel === undefined ? canonicalSpeakerHint : undefined)
        : canonicalizeSpeakerName(normalizedSpeakerLabel, speakerAliasIndex) ?? canonicalSpeakerHint;
      const speakerResolved = Boolean(speakerName);
      return {
        ...utterance,
        speakerLabel: normalizedSpeakerLabel,
        speakerName,
        speakerResolved,
        speakerAmbiguous,
        normalizedText: narrativizeFirstPerson(
          utterance.rawText,
          speakerName
        )
      };
    })()
  }));

  const claimPromotionSkipped = shouldSkipClaimPromotion(utterances);
  const scenes = buildTranscriptScenes({
    utterances,
    capturedAt: input.capturedAt,
    claimPromotionSkipped
  });

  const fragments: FragmentRecord[] = [];
  const candidateWrites: CandidateMemoryWrite[] = [];
  const sceneSources = new Map<number, { sourceMemoryIds: string[]; sourceChunkIds: string[]; occurredAt: string }>();
  let episodicInsertCount = 0;
  let chunkSeed = 50000;

  for (const utterance of utterances) {
    await client.query(
      `
        INSERT INTO transcript_utterances (
          namespace_id,
          artifact_id,
          artifact_observation_id,
          derivation_id,
          utterance_index,
          speaker_label,
          speaker_name,
          start_ms,
          end_ms,
          occurred_at,
          confidence,
          utterance_text,
          normalized_text,
          metadata
        )
        VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::timestamptz, $11, $12, $13, $14::jsonb)
        ON CONFLICT (artifact_observation_id, utterance_index)
        DO UPDATE SET
          derivation_id = EXCLUDED.derivation_id,
          speaker_label = EXCLUDED.speaker_label,
          speaker_name = EXCLUDED.speaker_name,
          start_ms = EXCLUDED.start_ms,
          end_ms = EXCLUDED.end_ms,
          occurred_at = EXCLUDED.occurred_at,
          confidence = EXCLUDED.confidence,
          utterance_text = EXCLUDED.utterance_text,
          normalized_text = EXCLUDED.normalized_text,
          metadata = transcript_utterances.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        input.namespaceId,
        input.artifactId,
        input.observationId,
        input.derivationId ?? null,
        utterance.utteranceIndex,
        utterance.speakerLabel ?? null,
        utterance.speakerName ?? canonicalSpeakerHint ?? utterance.speakerLabel ?? null,
        utterance.startMs ?? null,
        utterance.endMs ?? null,
        utterance.occurredAt,
        utterance.confidence ?? null,
        utterance.rawText,
        utterance.normalizedText,
        JSON.stringify({
          source_type: input.sourceType ?? "transcript",
          source_channel: input.sourceChannel ?? null,
          speaker_resolved: utterance.speakerResolved,
          speaker_unknown: !utterance.speakerResolved,
          speaker_ambiguous: utterance.speakerAmbiguous ?? false,
          occurred_at: utterance.occurredAt,
          language: decoded.language ?? null,
          duration_seconds: decoded.durationSeconds ?? null,
          source_filename: decoded.sourceFilename ?? null,
          transcript_metadata: input.transcriptMetadata ?? {}
        })
      ]
    );

    const fragmentSourceText = claimPromotionSkipped ? utterance.rawText : utterance.normalizedText;
    const utteranceFragments = splitIntoFragments(fragmentSourceText, utterance.occurredAt, input.capturedAt).map((fragment, localIndex) => ({
      ...fragment,
      fragmentIndex: nextChunkIndex(chunkSeed, utterance.utteranceIndex, localIndex),
      sceneIndex: utterance.utteranceIndex,
      charStart:
        typeof utterance.charStart === "number" && typeof fragment.charStart === "number"
          ? utterance.charStart + fragment.charStart
          : utterance.charStart,
      charEnd:
        typeof utterance.charStart === "number" && typeof fragment.charEnd === "number"
          ? utterance.charStart + fragment.charEnd
          : utterance.charEnd
    }));

    if (utteranceFragments.length === 0) {
      utteranceFragments.push({
        fragmentIndex: nextChunkIndex(chunkSeed, utterance.utteranceIndex, 0),
        sceneIndex: utterance.utteranceIndex,
        text: fragmentSourceText,
        charStart: utterance.charStart,
        charEnd: utterance.charEnd,
        speaker: utterance.speakerLabel,
        occurredAt: utterance.occurredAt,
        importanceScore: 0.5,
        tags: ["transcript"]
      });
    }

    for (const fragment of utteranceFragments) {
      const metadata = {
        ...(input.baseMetadata ?? {}),
        transcript_derivation_id: input.derivationId ?? null,
        transcript_utterance_index: utterance.utteranceIndex,
        transcript_speaker_label: utterance.speakerLabel ?? null,
        transcript_speaker_name: utterance.speakerName ?? canonicalSpeakerHint ?? utterance.speakerLabel ?? null,
        transcript_speaker_resolved: utterance.speakerResolved,
        transcript_speaker_ambiguous: utterance.speakerAmbiguous ?? false,
        transcript_confidence: utterance.confidence ?? null,
        transcript_start_ms: utterance.startMs ?? null,
        transcript_end_ms: utterance.endMs ?? null,
        importance_score: fragment.importanceScore ?? null,
        tags: [...(fragment.tags ?? []), "transcript"],
        source_type: input.sourceType ?? "transcript",
        ...(deriveSalienceMetadata(fragment.text) ?? {})
      };

      const inserted = await insertFragment(client, {
        artifactId: input.artifactId,
        observationId: input.observationId,
        namespaceId: input.namespaceId,
        sessionId: input.sessionId,
        content: fragment.text,
        fragmentIndex: fragment.fragmentIndex,
        charStart: fragment.charStart,
        charEnd: fragment.charEnd,
        occurredAt: fragment.occurredAt,
        capturedAt: input.capturedAt,
        metadata,
        disableCandidatePromotion: true
      });

      fragments.push(fragment);
      candidateWrites.push(...inserted.candidates);
      if (inserted.episodicInserted) {
        episodicInsertCount += 1;
      }

      const bucket = sceneSources.get(utterance.utteranceIndex) ?? {
        sourceMemoryIds: [],
        sourceChunkIds: [],
        occurredAt: utterance.occurredAt
      };
      if (inserted.sourceMemoryId) {
        bucket.sourceMemoryIds.push(inserted.sourceMemoryId);
      }
      bucket.sourceChunkIds.push(inserted.sourceChunkId);
      sceneSources.set(utterance.utteranceIndex, bucket);
    }
  }

  if (!claimPromotionSkipped) {
    await stageNarrativeClaims(client, {
      namespaceId: input.namespaceId,
      artifactId: input.artifactId,
      observationId: input.observationId,
      capturedAt: input.capturedAt,
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
    fragments,
    candidateWrites,
    episodicInsertCount,
    utteranceCount: utterances.length,
    claimPromotionSkipped
  };
}

export async function ingestTranscriptDerivation(input: {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly observationId: string;
  readonly derivationId?: string;
  readonly capturedAt: string;
  readonly transcriptText: string;
  readonly metadata?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly sourceType?: SourceType;
  readonly sourceChannel?: string;
  readonly sourceUri?: string;
}): Promise<{
  readonly fragments: readonly FragmentRecord[];
  readonly candidateWrites: readonly CandidateMemoryWrite[];
  readonly episodicInsertCount: number;
  readonly utteranceCount: number;
  readonly claimPromotionSkipped: boolean;
}> {
  return withTransaction(async (client) =>
    promoteTranscriptArtifactForClient(client, {
      namespaceId: input.namespaceId,
      artifactId: input.artifactId,
      observationId: input.observationId,
      capturedAt: input.capturedAt,
      transcriptText: input.transcriptText,
      transcriptMetadata: input.metadata,
      sessionId: input.sessionId,
      derivationId: input.derivationId,
      sourceType: input.sourceType ?? "transcript",
      sourceChannel: input.sourceChannel ?? "artifact_derivation:transcript",
      baseMetadata: input.metadata,
      sourceUri: input.sourceUri
    })
  );
}
