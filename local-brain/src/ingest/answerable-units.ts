import type { PoolClient } from "pg";

export interface InsertedFragmentRef {
  readonly sourceMemoryId?: string;
  readonly sourceChunkId: string;
  readonly content: string;
  readonly occurredAt: string;
  readonly charStart?: number;
  readonly charEnd?: number;
  readonly metadata?: Record<string, unknown>;
}

interface ConversationTurn {
  readonly turnIndex: number;
  readonly speaker: string;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
}

interface TopicSegment {
  readonly segmentIndex: number;
  readonly speakerNames: readonly string[];
  readonly content: string;
  readonly charStart: number;
  readonly charEnd: number;
}

interface SentenceSpan {
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
}

export interface AnswerableUnitInsert {
  readonly sourceKind: "episodic_memory" | "artifact_derivation";
  readonly sourceMemoryId?: string;
  readonly sourceDerivationId?: string;
  readonly sourceChunkId?: string;
  readonly unitType: "participant_turn" | "source_sentence" | "event_span" | "date_span" | "fact_span";
  readonly contentText: string;
  readonly ownerEntityHint?: string | null;
  readonly speakerEntityHint?: string | null;
  readonly participantNames: readonly string[];
  readonly charStart?: number | null;
  readonly charEnd?: number | null;
  readonly turnIndex?: number | null;
  readonly turnStartIndex?: number | null;
  readonly turnEndIndex?: number | null;
  readonly occurredAt?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly isCurrent?: boolean | null;
  readonly ownershipConfidence: number;
  readonly provenance: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
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

const MONTH_LOOKUP = new Map<string, number>([
  ["january", 1],
  ["february", 2],
  ["march", 3],
  ["april", 4],
  ["may", 5],
  ["june", 6],
  ["july", 7],
  ["august", 8],
  ["september", 9],
  ["october", 10],
  ["november", 11],
  ["december", 12]
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
    if (!match?.[1] || !match?.[2]) {
      continue;
    }
    const speaker = canonicalizeConversationSpeaker(match[1]);
    const text = normalizeWhitespace(match[2]);
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

function buildTopicLabel(turns: readonly ConversationTurn[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    for (const term of topicTermsForTurn(turn.text, turn.speaker)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([term]) => term);
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
    const rankedTerms = buildTopicLabel(current);
    if (rankedTerms.length === 0) {
      current = [];
      currentTerms = [];
      return;
    }
    const first = current[0]!;
    const last = current[current.length - 1]!;
    const speakerNames = [...new Set(current.map((turn) => turn.speaker))];
    segments.push({
      segmentIndex: segments.length,
      speakerNames,
      content: [
        `Topic segment about ${rankedTerms.slice(0, 3).join(", ")}.`,
        ...current.map((turn) => `${turn.speaker}: ${turn.text}`)
      ].join("\n"),
      charStart: first.charStart,
      charEnd: last.charEnd
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
      ((currentTerms.length > 0 && turnTerms.length > 0 && overlap === 0) || TOPIC_SEGMENT_SURPRISE_CUE.test(turn.text));
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

function splitSentencesWithOffsets(text: string, baseCharStart: number): readonly SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const sentenceRegex = /[^.!?\n]+(?:[.!?]+|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = sentenceRegex.exec(text)) !== null) {
    const raw = match[0] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const relativeOffset = raw.indexOf(trimmed);
    const charStart = baseCharStart + match.index + Math.max(0, relativeOffset);
    spans.push({
      text: trimmed,
      charStart,
      charEnd: charStart + trimmed.length
    });
  }
  return spans;
}

function findOverlappingFragment(
  fragments: readonly InsertedFragmentRef[],
  charStart: number,
  charEnd: number
): InsertedFragmentRef | null {
  const overlapping = fragments.filter((fragment) => {
    if (!fragment.sourceMemoryId) {
      return false;
    }
    if (typeof fragment.charStart !== "number" || typeof fragment.charEnd !== "number") {
      return false;
    }
    return fragment.charEnd > charStart && fragment.charStart < charEnd;
  });
  if (overlapping.length > 0) {
    return overlapping[0] ?? null;
  }
  return fragments.find((fragment) => fragment.sourceMemoryId) ?? null;
}

function explicitDateMetadata(text: string): Record<string, unknown> | null {
  const normalized = normalizeWhitespace(text);
  const dayMonthYear = normalized.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:,)?\s+(20\d{2}|19\d{2})\b/iu
  );
  if (dayMonthYear) {
    return {
      date_text: dayMonthYear[0],
      month: MONTH_LOOKUP.get(dayMonthYear[2]!.toLowerCase()) ?? null,
      day: Number(dayMonthYear[1]),
      year: Number(dayMonthYear[3]),
      temporal_basis: "explicit_text"
    };
  }
  const monthDayYear = normalized.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(20\d{2}|19\d{2})\b/iu
  );
  if (monthDayYear) {
    return {
      date_text: monthDayYear[0],
      month: MONTH_LOOKUP.get(monthDayYear[1]!.toLowerCase()) ?? null,
      day: Number(monthDayYear[2]),
      year: Number(monthDayYear[3]),
      temporal_basis: "explicit_text"
    };
  }
  const monthYear = normalized.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2}|19\d{2})\b/iu
  );
  if (monthYear) {
    return {
      date_text: monthYear[0],
      month: MONTH_LOOKUP.get(monthYear[1]!.toLowerCase()) ?? null,
      year: Number(monthYear[2]),
      temporal_basis: "explicit_text"
    };
  }
  const bareYear = normalized.match(/\b(20\d{2}|19\d{2})\b/u);
  if (bareYear) {
    return {
      date_text: bareYear[0],
      year: Number(bareYear[1]),
      temporal_basis: "explicit_text"
    };
  }
  const relative = normalized.match(/\b(today|yesterday|tomorrow|last week|this month|earlier this month|last month|next month|last year|this year|next year)\b/iu);
  if (relative) {
    return {
      date_text: relative[0],
      relative_label: relative[0].toLowerCase(),
      temporal_basis: "relative_text"
    };
  }
  return null;
}

function hasFactCue(text: string): boolean {
  return /\b(adopt(?:ed)?|favorite|favourite|name(?:d)?|married|pass(?:ed)? away|buy|bought|travel(?:ed)?|visit(?:ed)?|live(?:d)?|work(?:ed|ing)?|job|pet|snake|dog|cat|bird|advice|plan(?:ned)?|stay|leave|left|move(?:d)?|pendant|mother|father)\b/iu.test(text);
}

function hasEventCue(text: string): boolean {
  return /\b(adopt(?:ed)?|lost|pass(?:ed)? away|travel(?:ed)?|visit(?:ed)?|move(?:d)?|saw|watched|met|bought|started|launched|planned|stayed|received)\b/iu.test(text);
}

function extractCapitalizedNames(text: string): readonly string[] {
  const matches = text.match(/\b[A-Z][a-z]+\b/gu) ?? [];
  const stopTerms = new Set([
    "What",
    "When",
    "Where",
    "Why",
    "How",
    "Which",
    "Who",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ]);
  return [...new Set(matches.filter((value) => !stopTerms.has(value)).map((value) => value.toLowerCase()))];
}

function ownershipForSentence(
  sentence: string,
  participants: readonly string[],
  speakerName?: string | null
): {
  readonly ownerEntityHint?: string;
  readonly speakerEntityHint?: string;
  readonly participantNames: readonly string[];
  readonly ownershipConfidence: number;
  readonly mixed: boolean;
} {
  const lowerParticipants = participants.map((value) => normalizeWhitespace(value).toLowerCase()).filter(Boolean);
  const mentioned = lowerParticipants.filter((participant) => sentence.toLowerCase().includes(participant));
  if (speakerName) {
    const normalizedSpeaker = normalizeWhitespace(speakerName).toLowerCase();
    return {
      ownerEntityHint: normalizedSpeaker,
      speakerEntityHint: normalizedSpeaker,
      participantNames: [...new Set([normalizedSpeaker, ...mentioned])],
      ownershipConfidence: mentioned.length > 1 ? 0.82 : 0.95,
      mixed: mentioned.filter((value) => value !== normalizedSpeaker).length > 0
    };
  }
  if (mentioned.length === 1) {
    return {
      ownerEntityHint: mentioned[0],
      speakerEntityHint: undefined,
      participantNames: mentioned,
      ownershipConfidence: 0.72,
      mixed: false
    };
  }
  return {
    ownerEntityHint: undefined,
    speakerEntityHint: undefined,
    participantNames: mentioned,
    ownershipConfidence: mentioned.length > 1 ? 0.35 : 0.2,
    mixed: mentioned.length > 1
  };
}

function unitMetadata(
  extra: Record<string, unknown>,
  mixed: boolean
): Record<string, unknown> {
  return {
    ...extra,
    mixed_subject_signal: mixed
  };
}

function buildSentenceDerivedUnits(options: {
  readonly sourceKind: "episodic_memory" | "artifact_derivation";
  readonly sourceMemoryId?: string;
  readonly sourceDerivationId?: string;
  readonly sourceChunkId?: string;
  readonly artifactId?: string;
  readonly artifactObservationId: string;
  readonly occurredAt?: string | null;
  readonly speakerName?: string | null;
  readonly participantNames: readonly string[];
  readonly sentence: SentenceSpan;
  readonly turnIndex?: number | null;
  readonly metadata?: Record<string, unknown>;
}): readonly AnswerableUnitInsert[] {
  const ownership = ownershipForSentence(options.sentence.text, options.participantNames, options.speakerName ?? undefined);
  const base: AnswerableUnitInsert = {
    sourceKind: options.sourceKind,
    sourceMemoryId: options.sourceMemoryId,
    sourceDerivationId: options.sourceDerivationId,
    sourceChunkId: options.sourceChunkId,
    unitType: "source_sentence",
    contentText: options.sentence.text,
    ownerEntityHint: ownership.ownerEntityHint ?? null,
    speakerEntityHint: ownership.speakerEntityHint ?? null,
    participantNames: ownership.participantNames,
    charStart: options.sentence.charStart,
    charEnd: options.sentence.charEnd,
    turnIndex: options.turnIndex ?? null,
    turnStartIndex: options.turnIndex ?? null,
    turnEndIndex: options.turnIndex ?? null,
    occurredAt: options.occurredAt ?? null,
    validFrom: null,
    validUntil: null,
    isCurrent: null,
    ownershipConfidence: ownership.ownershipConfidence,
    provenance: {
      artifact_observation_id: options.artifactObservationId,
      artifact_id: options.artifactId ?? null,
      source_chunk_id: options.sourceChunkId ?? null,
      sentence_char_start: options.sentence.charStart,
      sentence_char_end: options.sentence.charEnd
    },
    metadata: unitMetadata(
      {
        sentence_text: options.sentence.text,
        source_kind: options.sourceKind,
        ...options.metadata
      },
      ownership.mixed
    )
  };
  const units: AnswerableUnitInsert[] = [base];
  const dateMetadata = explicitDateMetadata(options.sentence.text);
  if (dateMetadata) {
    units.push({
      ...base,
      unitType: "date_span",
      ownershipConfidence: Math.max(base.ownershipConfidence, 0.78),
      metadata: unitMetadata(
        {
          ...base.metadata,
          ...dateMetadata
        },
        ownership.mixed
      )
    });
  }
  if (hasFactCue(options.sentence.text)) {
    units.push({
      ...base,
      unitType: "fact_span",
      ownershipConfidence: Math.max(base.ownershipConfidence, 0.74),
      metadata: unitMetadata(
        {
          ...base.metadata,
          fact_like: true
        },
        ownership.mixed
      )
    });
  }
  if (hasEventCue(options.sentence.text)) {
    units.push({
      ...base,
      unitType: "event_span",
      ownershipConfidence: Math.max(base.ownershipConfidence, 0.76),
      metadata: unitMetadata(
        {
          ...base.metadata,
          event_like: true
        },
        ownership.mixed
      )
    });
  }
  return units;
}

async function insertUnits(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly artifactObservationId: string;
    readonly artifactId: string;
    readonly units: readonly AnswerableUnitInsert[];
  }
): Promise<number> {
  await client.query(
    `
      DELETE FROM answerable_units
      WHERE artifact_observation_id = $1::uuid
    `,
    [input.artifactObservationId]
  );

  let insertedCount = 0;
  for (const unit of input.units) {
    await client.query(
      `
        INSERT INTO answerable_units (
          namespace_id,
          source_kind,
          source_memory_id,
          source_derivation_id,
          artifact_id,
          artifact_observation_id,
          source_chunk_id,
          unit_type,
          content_text,
          owner_entity_hint,
          speaker_entity_hint,
          participant_names,
          char_start,
          char_end,
          turn_index,
          turn_start_index,
          turn_end_index,
          occurred_at,
          valid_from,
          valid_until,
          is_current,
          ownership_confidence,
          provenance,
          metadata
        )
        VALUES (
          $1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10, $11, $12::jsonb,
          $13, $14, $15, $16, $17, $18::timestamptz, $19::timestamptz, $20::timestamptz, $21, $22, $23::jsonb, $24::jsonb
        )
        ON CONFLICT DO NOTHING
      `,
      [
        input.namespaceId,
        unit.sourceKind,
        unit.sourceMemoryId ?? null,
        unit.sourceDerivationId ?? null,
        input.artifactId,
        input.artifactObservationId,
        unit.sourceChunkId ?? null,
        unit.unitType,
        unit.contentText,
        unit.ownerEntityHint ?? null,
        unit.speakerEntityHint ?? null,
        JSON.stringify(unit.participantNames),
        unit.charStart ?? null,
        unit.charEnd ?? null,
        unit.turnIndex ?? null,
        unit.turnStartIndex ?? null,
        unit.turnEndIndex ?? null,
        unit.occurredAt ?? null,
        unit.validFrom ?? null,
        unit.validUntil ?? null,
        unit.isCurrent ?? null,
        unit.ownershipConfidence,
        JSON.stringify(unit.provenance),
        JSON.stringify(unit.metadata)
      ]
    );
    insertedCount += 1;
  }

  return insertedCount;
}

export function previewAnswerableUnits(input: {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly observationId: string;
  readonly normalizedText: string;
  readonly insertedFragments: readonly InsertedFragmentRef[];
  readonly metadata?: Record<string, unknown>;
}): readonly AnswerableUnitInsert[] {
  const turns = extractConversationTurns(input.normalizedText);
  const units: AnswerableUnitInsert[] = [];

  for (const turn of turns) {
    const fragment = findOverlappingFragment(input.insertedFragments, turn.charStart, turn.charEnd);
    if (!fragment?.sourceMemoryId) {
      continue;
    }
    const speaker = normalizeWhitespace(turn.speaker).toLowerCase();
    units.push({
      sourceKind: "episodic_memory",
      sourceMemoryId: fragment.sourceMemoryId,
      sourceChunkId: fragment.sourceChunkId,
      unitType: "participant_turn",
      contentText: `${turn.speaker}: ${turn.text}`,
      ownerEntityHint: speaker,
      speakerEntityHint: speaker,
      participantNames: [speaker],
      charStart: turn.charStart,
      charEnd: turn.charEnd,
      turnIndex: turn.turnIndex,
      turnStartIndex: turn.turnIndex,
      turnEndIndex: turn.turnIndex,
      occurredAt: fragment.occurredAt,
      validFrom: null,
      validUntil: null,
      isCurrent: null,
      ownershipConfidence: 1,
      provenance: {
        artifact_observation_id: input.observationId,
        artifact_id: input.artifactId,
        source_chunk_id: fragment.sourceChunkId,
        turn_index: turn.turnIndex
      },
      metadata: {
        source_kind: "episodic_memory",
        speaker_name: turn.speaker,
        source_chunk_id: fragment.sourceChunkId,
        source_metadata: input.metadata ?? {}
      }
    });
    for (const sentence of splitSentencesWithOffsets(turn.text, turn.charStart)) {
      units.push(
        ...buildSentenceDerivedUnits({
          sourceKind: "episodic_memory",
          sourceMemoryId: fragment.sourceMemoryId,
          sourceChunkId: fragment.sourceChunkId,
          artifactId: input.artifactId,
          artifactObservationId: input.observationId,
          occurredAt: fragment.occurredAt,
          speakerName: turn.speaker,
          participantNames: [turn.speaker],
          sentence,
          turnIndex: turn.turnIndex,
          metadata: {
            source_turn_text: turn.text,
            source_metadata: input.metadata ?? {}
          }
        })
      );
    }
  }

  for (const segment of buildTopicSegments(turns)) {
    const segmentBody = segment.content.split("\n").slice(1).join("\n");
    for (const sentence of splitSentencesWithOffsets(segmentBody, segment.charStart)) {
      const fragment = findOverlappingFragment(input.insertedFragments, sentence.charStart, sentence.charEnd);
      if (!fragment?.sourceMemoryId) {
        continue;
      }
      units.push(
        ...buildSentenceDerivedUnits({
          sourceKind: "episodic_memory",
          sourceMemoryId: fragment.sourceMemoryId,
          sourceChunkId: fragment.sourceChunkId,
          artifactId: input.artifactId,
          artifactObservationId: input.observationId,
          occurredAt: fragment.occurredAt,
          participantNames: segment.speakerNames,
          sentence,
          metadata: {
            topic_segment_index: segment.segmentIndex,
            source_metadata: input.metadata ?? {}
          }
        })
      );
    }
  }

  if (turns.length === 0) {
    for (const fragment of input.insertedFragments) {
      if (!fragment.sourceMemoryId) {
        continue;
      }
      const participants = extractCapitalizedNames(fragment.content);
      for (const sentence of splitSentencesWithOffsets(fragment.content, fragment.charStart ?? 0)) {
        units.push(
          ...buildSentenceDerivedUnits({
            sourceKind: "episodic_memory",
            sourceMemoryId: fragment.sourceMemoryId,
            sourceChunkId: fragment.sourceChunkId,
            artifactId: input.artifactId,
            artifactObservationId: input.observationId,
            occurredAt: fragment.occurredAt,
            participantNames: participants,
            sentence,
            metadata: {
              source_metadata: input.metadata ?? {},
              fragment_metadata: fragment.metadata ?? {}
            }
          })
        );
      }
    }
  }

  return units;
}

export async function attachAnswerableUnitsForClient(
  client: PoolClient,
  input: {
    readonly namespaceId: string;
    readonly artifactId: string;
    readonly observationId: string;
    readonly normalizedText: string;
    readonly insertedFragments: readonly InsertedFragmentRef[];
    readonly metadata?: Record<string, unknown>;
  }
): Promise<number> {
  const units = previewAnswerableUnits(input);

  if (units.length === 0) {
    await client.query(
      `
        DELETE FROM answerable_units
        WHERE artifact_observation_id = $1::uuid
      `,
      [input.observationId]
    );
    return 0;
  }

  return insertUnits(client, {
    namespaceId: input.namespaceId,
    artifactId: input.artifactId,
    artifactObservationId: input.observationId,
    units
  });
}
