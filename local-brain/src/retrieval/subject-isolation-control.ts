import type { RecallResult } from "../types.js";
import { parseQueryEntityFocus } from "./query-entity-focus.js";

export type SubjectIsolationStatus = "subject_owned" | "mixed_subject" | "foreign_subject" | "no_subject_signal";

export interface SubjectIsolationTelemetry {
  readonly subjectIsolationApplied: boolean;
  readonly subjectIsolationOwnedCount: number;
  readonly subjectIsolationDiscardedMixedCount: number;
  readonly subjectIsolationDiscardedForeignCount: number;
  readonly subjectIsolationTopResultOwned: boolean;
}

export interface SubjectIsolationEvaluation {
  readonly result: RecallResult;
  readonly status: SubjectIsolationStatus;
  readonly derivationType: string;
  readonly targetHints: readonly string[];
  readonly strictSignals: readonly string[];
  readonly targetSignalHit: boolean;
  readonly foreignSignalCount: number;
  readonly primarySpeakerTurnCount: number;
  readonly foreignSpeakerTurnCount: number;
  readonly hasSourceSentenceTargetHit: boolean;
  readonly isFallbackRow: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function derivationTypeForResult(result: RecallResult): string {
  if (typeof result.provenance.derivation_type === "string" && result.provenance.derivation_type.length > 0) {
    return result.provenance.derivation_type;
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return typeof metadata?.derivation_type === "string" ? metadata.derivation_type : "";
}

function parseConversationSpeakerTurns(content: string): readonly { speaker: string; text: string }[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^([^:\n]{2,80}):\s+(.+)$/u);
      if (!match?.[1] || !match?.[2]) {
        return [];
      }
      return [{
        speaker: normalizeWhitespace(match[1]).toLowerCase(),
        text: normalizeWhitespace(match[2]).toLowerCase()
      }];
    });
}

function collectStrictSubjectSignals(result: RecallResult): readonly string[] {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizeWhitespace(value).toLowerCase();
    if (normalized) {
      names.add(normalized);
    }
  };

  add(result.provenance.subject_name);
  add(result.provenance.object_name);
  add(result.provenance.transcript_speaker_name);
  add(result.provenance.speaker_name);
  add(result.provenance.canonical_name);
  add(result.provenance.owner_entity_hint);
  add(result.provenance.speaker_entity_hint);
  const topLevelParticipantNames = Array.isArray(result.provenance.participant_names)
    ? result.provenance.participant_names
    : [];
  for (const participant of topLevelParticipantNames) {
    add(participant);
  }

  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  if (metadata) {
    add(metadata.subject_name);
    add(metadata.object_name);
    add(metadata.transcript_speaker_name);
    add(metadata.speaker_name);
    add(metadata.canonical_name);
    add(metadata.primary_speaker_name);
    add(metadata.owner_entity_hint);
    add(metadata.speaker_entity_hint);
    const participantNames = Array.isArray(metadata.participant_names) ? metadata.participant_names : [];
    for (const participant of participantNames) {
      add(participant);
    }
  }

  for (const turn of parseConversationSpeakerTurns(result.content)) {
    add(turn.speaker);
  }

  return [...names];
}

function sourceSentenceTargetHit(result: RecallResult, targetHints: readonly string[]): boolean {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const sourceSentenceText = typeof metadata?.source_sentence_text === "string" ? normalizeWhitespace(metadata.source_sentence_text).toLowerCase() : "";
  if (!sourceSentenceText) {
    return false;
  }
  return targetHints.some((hint) => sourceSentenceText.includes(hint));
}

function isFallbackRow(result: RecallResult): boolean {
  const normalized = normalizeWhitespace(result.content).toLowerCase();
  return normalized === "no authoritative evidence found." || normalized === "none.";
}

function allowsCompanionParticipants(result: RecallResult): boolean {
  const tier = typeof result.provenance.tier === "string" ? result.provenance.tier : "";
  if (["timeline_episodic", "narrative_event", "event_scene_support", "event_neighborhood_support", "temporal_summary"].includes(tier)) {
    return true;
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return (
    typeof metadata?.time_granularity === "string" ||
    typeof metadata?.time_expression_text === "string" ||
    Array.isArray(metadata?.participant_names)
  );
}

export function evaluateSubjectIsolationResult(
  queryText: string,
  result: RecallResult
): SubjectIsolationEvaluation {
  const focus = parseQueryEntityFocus(queryText);
  const targetHints = focus.primaryHints.map((value) => normalizeWhitespace(value).toLowerCase()).filter(Boolean);
  const companionHints = focus.companionHints.map((value) => normalizeWhitespace(value).toLowerCase()).filter(Boolean);
  const derivationType = derivationTypeForResult(result);
  const strictSignals = collectStrictSubjectSignals(result);
  const targetSignalHit = strictSignals.some((signal) => targetHints.some((hint) => signal.includes(hint)));
  const foreignSignalCount = strictSignals.filter(
    (signal) =>
      !targetHints.some((hint) => signal.includes(hint)) &&
      !companionHints.some((hint) => signal.includes(hint))
  ).length;
  const speakerTurns = parseConversationSpeakerTurns(result.content);
  const primarySpeakerTurnCount = speakerTurns.filter((turn) => targetHints.some((hint) => turn.speaker.includes(hint))).length;
  const foreignSpeakerTurnCount = speakerTurns.filter(
    (turn) =>
      !targetHints.some((hint) => turn.speaker.includes(hint)) &&
      !companionHints.some((hint) => turn.speaker.includes(hint))
  ).length;
  const hasSourceSentenceTargetHit = sourceSentenceTargetHit(result, targetHints);
  const fallbackRow = isFallbackRow(result);

  let status: SubjectIsolationStatus = "no_subject_signal";
  if (targetHints.length !== 1) {
    status = "subject_owned";
  } else if (fallbackRow && !targetSignalHit && primarySpeakerTurnCount === 0 && !hasSourceSentenceTargetHit) {
    status = foreignSignalCount > 0 ? "foreign_subject" : "no_subject_signal";
  } else if (derivationType === "participant_turn" || derivationType === "source_sentence") {
    if (primarySpeakerTurnCount > 0 && foreignSpeakerTurnCount === 0) {
      status = "subject_owned";
    } else if (primarySpeakerTurnCount > 0 && foreignSpeakerTurnCount > 0) {
      status = "mixed_subject";
    } else if (foreignSpeakerTurnCount > 0) {
      status = "foreign_subject";
    } else if (targetSignalHit || hasSourceSentenceTargetHit) {
      status = foreignSignalCount > 0 ? "mixed_subject" : "subject_owned";
    } else {
      status = foreignSignalCount > 0 ? "foreign_subject" : "no_subject_signal";
    }
  } else if (speakerTurns.length > 0) {
    if (primarySpeakerTurnCount > 0 && foreignSpeakerTurnCount > 0) {
      status = "mixed_subject";
    } else if (primarySpeakerTurnCount > 0) {
      status = "subject_owned";
    } else if (foreignSpeakerTurnCount > 0) {
      status = "foreign_subject";
    } else if (targetSignalHit || hasSourceSentenceTargetHit) {
      status = foreignSignalCount > 0 ? "mixed_subject" : "subject_owned";
    } else {
      status = foreignSignalCount > 0 ? "foreign_subject" : "no_subject_signal";
    }
  } else if (targetSignalHit || hasSourceSentenceTargetHit) {
    status = foreignSignalCount > 0 && !allowsCompanionParticipants(result) ? "mixed_subject" : "subject_owned";
  } else if (foreignSignalCount > 0) {
    status = "foreign_subject";
  }

  return {
    result,
    status,
    derivationType,
    targetHints,
    strictSignals,
    targetSignalHit,
    foreignSignalCount,
    primarySpeakerTurnCount,
    foreignSpeakerTurnCount,
    hasSourceSentenceTargetHit,
    isFallbackRow: fallbackRow
  };
}

export function retainSubjectIsolatedRecallResults(
  queryText: string,
  results: readonly RecallResult[],
  limit: number
): {
  readonly results: readonly RecallResult[];
  readonly telemetry: SubjectIsolationTelemetry;
  readonly evaluations: readonly SubjectIsolationEvaluation[];
} {
  const targetHints = parseQueryEntityFocus(queryText).primaryHints
    .map((value) => normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (targetHints.length !== 1 || results.length <= 1) {
    return {
      results,
      telemetry: {
        subjectIsolationApplied: false,
        subjectIsolationOwnedCount: 0,
        subjectIsolationDiscardedMixedCount: 0,
        subjectIsolationDiscardedForeignCount: 0,
        subjectIsolationTopResultOwned: false
      },
      evaluations: []
    };
  }

  const evaluations = results.map((result) => evaluateSubjectIsolationResult(queryText, result));
  const ownedCount = evaluations.filter((evaluation) => evaluation.status === "subject_owned").length;
  let discardedMixedCount = 0;
  let discardedForeignCount = 0;

  const rescored = evaluations.flatMap((evaluation) => {
    let score = typeof evaluation.result.score === "number" ? evaluation.result.score : 0;
    switch (evaluation.status) {
      case "subject_owned":
        score += 2.2;
        break;
      case "mixed_subject":
        score -= 1.5;
        break;
      case "foreign_subject":
        score -= 2.25;
        break;
      case "no_subject_signal":
      default:
        score -= 0.65;
        break;
    }

    if (evaluation.derivationType === "participant_turn" || evaluation.derivationType === "source_sentence") {
      score += evaluation.status === "subject_owned" ? 0.85 : -0.55;
    }
    if (evaluation.derivationType === "conversation_unit" || evaluation.derivationType === "topic_segment") {
      if (evaluation.status === "mixed_subject" || evaluation.status === "foreign_subject") {
        score -= 0.95;
      }
    }
    if ((evaluation.result.memoryType === "episodic_memory" || evaluation.result.memoryType === "narrative_event") && evaluation.foreignSpeakerTurnCount > 0 && evaluation.primarySpeakerTurnCount > 0) {
      score -= 0.85;
    }
    if (evaluation.isFallbackRow && evaluation.status !== "subject_owned") {
      score -= 2.5;
    }

    if (ownedCount > 0) {
      if (evaluation.status === "foreign_subject") {
        discardedForeignCount += 1;
        return [];
      }
      if (
        evaluation.status === "mixed_subject" &&
        (evaluation.derivationType === "conversation_unit" ||
          evaluation.derivationType === "topic_segment" ||
          evaluation.result.memoryType === "episodic_memory" ||
          evaluation.result.memoryType === "narrative_event")
      ) {
        discardedMixedCount += 1;
        return [];
      }
      if (evaluation.isFallbackRow && evaluation.status !== "subject_owned") {
        return [];
      }
    }

    return [{ evaluation, score }];
  });

  rescored.sort((left, right) => right.score - left.score);
  const retainedEvaluations = rescored.slice(0, limit).map((entry) => entry.evaluation);
  const retainedResults = retainedEvaluations.map((entry) => entry.result);

  return {
    results: retainedResults,
    telemetry: {
      subjectIsolationApplied: true,
      subjectIsolationOwnedCount: ownedCount,
      subjectIsolationDiscardedMixedCount: discardedMixedCount,
      subjectIsolationDiscardedForeignCount: discardedForeignCount,
      subjectIsolationTopResultOwned: retainedEvaluations[0]?.status === "subject_owned"
    },
    evaluations
  };
}
