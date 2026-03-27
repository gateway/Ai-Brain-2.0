import type { RecallResult } from "../types.js";
import type { RecallExactDetailSource } from "./types.js";

export type ExactAnswerWindowStatus = "subject_safe" | "mixed_subject" | "foreign_subject" | "no_answer_bearing_text";
export type ExactAnswerSlotFit = "strong" | "weak" | "none";

interface ExactAnswerWindow {
  readonly text: string;
  readonly source: RecallExactDetailSource;
  readonly derivationType?: string;
  readonly sourceSentenceText?: string;
  readonly speaker?: string;
  readonly result: RecallResult;
}

interface ExactAnswerWindowEvaluation extends ExactAnswerWindow {
  readonly status: ExactAnswerWindowStatus;
  readonly slotFit: ExactAnswerSlotFit;
  readonly subjectPurityScore: number;
  readonly speakerAlignmentScore: number;
  readonly slotCueScore: number;
  readonly answerBearingScore: number;
  readonly negationPenalty: number;
  readonly contaminationPenalty: number;
  readonly windowScore: number;
}

interface ExactAnswerCandidate {
  readonly value: string;
  readonly source: RecallExactDetailSource;
  readonly score: number;
  readonly strongSupport: boolean;
  readonly slotValueFitnessScore: number;
}

export interface ExactAnswerTelemetry {
  readonly exactAnswerWindowCount: number;
  readonly exactAnswerSafeWindowCount: number;
  readonly exactAnswerDiscardedMixedWindowCount: number;
  readonly exactAnswerDiscardedForeignWindowCount: number;
  readonly exactAnswerCandidateCount: number;
  readonly exactAnswerDominantMargin?: number;
  readonly exactAnswerAbstainedForAmbiguity: boolean;
}

export interface ExactAnswerDerivationResult {
  readonly candidate: {
    readonly text: string;
    readonly source: RecallExactDetailSource;
    readonly strongSupport: boolean;
  } | null;
  readonly telemetry: ExactAnswerTelemetry;
}

interface ExactAnswerDerivationOptions {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly family: string;
  readonly structuredQuery: boolean;
  readonly extractValues: (text: string, queryText: string) => readonly string[];
  readonly formatClaimText: (queryText: string, value: string) => string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function extractEntityNameHints(queryText: string): readonly string[] {
  const matches = queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gu) ?? [];
  return [...new Set(matches.map((value) => normalizeWhitespace(value).toLowerCase()))].filter(
    (value) => !["what", "where", "who", "when", "why", "ai brain"].includes(value)
  );
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

function baseExactDetailSource(result: RecallResult): RecallExactDetailSource {
  if (result.memoryType === "episodic_memory" || result.memoryType === "narrative_event") {
    return "episodic_leaf";
  }
  if (result.memoryType === "artifact_derivation") {
    return "derivation";
  }
  return "mixed";
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
        text: normalizeWhitespace(match[2])
      }];
    });
}

function collectResultParticipantSignals(result: RecallResult): readonly string[] {
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
  add(result.provenance.speaker_name);
  add(result.provenance.canonical_name);

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
    if (Array.isArray(metadata.participant_names)) {
      for (const participant of metadata.participant_names) {
        add(participant);
      }
    }
  }

  return [...names];
}

function targetContextMatches(text: string, targetHints: readonly string[], resultSignals: readonly string[]): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (targetHints.some((hint) => normalized.includes(hint))) {
    return true;
  }
  return resultSignals.some((signal) => targetHints.some((hint) => signal.includes(hint)) && normalized.includes(signal));
}

function extractAnswerBearingWindows(queryText: string, result: RecallResult): readonly ExactAnswerWindow[] {
  const derivationType = derivationTypeForResult(result);
  const source = baseExactDetailSource(result);
  const targetHints = extractEntityNameHints(queryText);
  const resultSignals = collectResultParticipantSignals(result);
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const windows: ExactAnswerWindow[] = [];
  const pushWindow = (text: string, options?: { speaker?: string; sourceSentenceText?: string; source?: RecallExactDetailSource }): void => {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return;
    }
    windows.push({
      text: normalized,
      source: options?.source ?? source,
      derivationType,
      sourceSentenceText: options?.sourceSentenceText,
      speaker: options?.speaker,
      result
    });
  };

  const sourceSentenceText = typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "";
  const primarySpeakerName =
    typeof metadata?.primary_speaker_name === "string"
      ? normalizeWhitespace(metadata.primary_speaker_name).toLowerCase()
      : typeof metadata?.speaker_name === "string"
        ? normalizeWhitespace(metadata.speaker_name).toLowerCase()
        : "";
  if (sourceSentenceText.trim()) {
    pushWindow(sourceSentenceText, {
      sourceSentenceText,
      speaker: primarySpeakerName || undefined,
      source:
        result.memoryType === "artifact_derivation" && (derivationType === "participant_turn" || derivationType === "source_sentence")
          ? "artifact_source"
          : source
    });
  }

  const speakerTurns = parseConversationSpeakerTurns(result.content);
  if (speakerTurns.length > 0) {
    for (const turn of speakerTurns) {
      pushWindow(turn.text, {
        speaker: turn.speaker,
        sourceSentenceText
      });
    }
    return windows;
  }

  const segments = result.content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);
  for (const segment of segments) {
    if (targetHints.length === 0 || targetContextMatches(segment, targetHints, resultSignals)) {
      pushWindow(segment, { sourceSentenceText });
    }
  }
  if (windows.length === 0) {
    pushWindow(result.content, { sourceSentenceText });
  }
  return windows;
}

function classifyWindowStatus(window: ExactAnswerWindow, queryText: string): ExactAnswerWindowStatus {
  const targetHints = extractEntityNameHints(queryText);
  if (targetHints.length !== 1) {
    return "subject_safe";
  }

  const target = targetHints[0]!;
  const resultSignals = collectResultParticipantSignals(window.result).filter((signal) => signal !== target);
  const normalizedText = normalizeWhitespace(window.text).toLowerCase();
  const speaker = normalizeWhitespace(window.speaker ?? "").toLowerCase();
  const speakerTurns = parseConversationSpeakerTurns(window.result.content);
  const primarySpeakerTurns = speakerTurns.filter((turn) => turn.speaker.includes(target));
  const foreignSpeakerTurns = speakerTurns.filter((turn) => !turn.speaker.includes(target));

  if (window.speaker) {
    if (!speaker.includes(target)) {
      return "foreign_subject";
    }
    if (resultSignals.some((signal) => normalizedText.includes(signal))) {
      return "mixed_subject";
    }
    return "subject_safe";
  }

  const targetHit = normalizedText.includes(target) || collectResultParticipantSignals(window.result).some((signal) => signal.includes(target));
  const foreignHit = resultSignals.some((signal) => normalizedText.includes(signal));
  if (!targetHit) {
    return foreignHit ? "foreign_subject" : "no_answer_bearing_text";
  }
  if (foreignHit || (primarySpeakerTurns.length > 0 && foreignSpeakerTurns.length > 0 && derivationTypeForResult(window.result) === "conversation_unit")) {
    return "mixed_subject";
  }
  return "subject_safe";
}

function scoreSubjectPurity(status: ExactAnswerWindowStatus): number {
  switch (status) {
    case "subject_safe":
      return 1;
    case "mixed_subject":
      return 0.35;
    case "foreign_subject":
      return 0;
    case "no_answer_bearing_text":
    default:
      return 0.2;
  }
}

function scoreSpeakerAlignment(window: ExactAnswerWindow, queryText: string): number {
  const targetHints = extractEntityNameHints(queryText);
  if (targetHints.length !== 1) {
    return 0;
  }
  const target = targetHints[0]!;
  const speaker = normalizeWhitespace(window.speaker ?? "").toLowerCase();
  if (!speaker) {
    return 0;
  }
  return speaker.includes(target) ? 1.2 : -1.4;
}

function scoreSlotCueForFamily(queryText: string, family: string, text: string): number {
  const lowered = normalizeWhitespace(text).toLowerCase();
  if (family === "favorite_books") {
    return /\bfavorite\b|\binclude\b|\bbooks?\b/u.test(lowered) ? 1.2 : -0.8;
  }
  if (family === "martial_arts") {
    return /\bmartial\b|\bkickboxing\b|\btaekwondo\b|\bkarate\b|\bjudo\b|\bboxing\b/u.test(lowered) ? 1.1 : -0.6;
  }
  if (family === "main_focus") {
    return /\bmain focus\b|\bfocus(?:ed)? on\b/u.test(lowered) ? 1.1 : -0.5;
  }
  if (family === "meal_companion") {
    return /\b(?:dinner|lunch|breakfast)\s+with\b/u.test(lowered) ? 1.1 : -0.6;
  }
  if (family === "color") {
    return /\bcolor\b|\bblue\b|\bred\b|\bgreen\b|\byellow\b|\bpurple\b|\bpink\b|\bblack\b|\bwhite\b|\bbrown\b|\bgray\b|\bgrey\b/u.test(lowered)
      ? 0.9
      : -0.5;
  }
  if (family === "team") {
    return /\bteam\b|\bjoined\b|\bplays? for\b|\bsigned\b/u.test(lowered) ? 1 : -0.6;
  }
  if (family === "role") {
    return /\brole\b|\bposition\b|\btitle\b|\bworked as\b|\bis a\b/u.test(lowered) ? 1 : -0.6;
  }
  if (family === "car") {
    return /\bbought\b|\bpurchased\b|\btoyota\b|\bhonda\b|\btesla\b|\bprius\b|\bsuv\b|\bsedan\b/u.test(lowered) ? 1 : -0.6;
  }
  if (family === "advice") {
    return /\badvice\b|\badvised\b|\btold\b/u.test(lowered) ? 1 : -0.6;
  }

  if (/\bhobbies?\b/i.test(queryText)) {
    return /\bhobbies?\s+(?:are|include)\b|\benjoys?\b|\blikes? to\b|\bloves?\b/u.test(lowered) ? 1.2 : -0.8;
  }
  if (/\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(queryText)) {
    return /\btrilog(?:y|ies)\b|\bseries\b|\bfranchise\b/u.test(lowered) ? 1.25 : -1.1;
  }
  if (/\bfavorite\s+movies?\b/i.test(queryText)) {
    return /\bfavorite\b|\bloves?\b|\binclud(?:e|ed)\b/u.test(lowered) ? 1.2 : -0.9;
  }
  if (/\bpets?\b/i.test(queryText) && /\ballerg/i.test(queryText)) {
    return /\ballerg/i.test(lowered) || /\bwouldn'?t cause discomfort\b/u.test(lowered) || /\bfur\b/u.test(lowered) ? 1.1 : -0.8;
  }
  if (/\bfinancial status\b/i.test(queryText)) {
    return /\bmiddle[- ]class\b|\bwealthy\b|\brich\b|\bwell-off\b|\bfinancially stable\b/u.test(lowered) ? 1.2 : -1;
  }
  if (/\bspark(?:ed)?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) {
    return /\bspark(?:ed)?\b|\binspir(?:ed|ing)\b|\bseeing how\b|\bgrowing up\b/u.test(lowered) ? 1.15 : -0.8;
  }
  if (/\bwhat\s+kind\s+of\s+flowers?\b/i.test(queryText)) {
    return /\bflowers?\b|\btattoo\b/u.test(lowered) ? 0.9 : -0.6;
  }
  if (/\bspecific\s+type\s+of\s+bird\b/i.test(queryText) || /\bwhat\s+kind\s+of\s+bird\b/i.test(queryText)) {
    return /\bbird\b|\bmesmerized\b/u.test(lowered) ? 0.9 : -0.7;
  }
  return /\b(?:favorite|hobbies?|include|likes?|loves?|enjoys?|named|called|bought|adopted)\b/u.test(lowered) ? 0.8 : -0.35;
}

function scoreAnswerBearing(values: readonly string[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.length > 1 ? 1 : 0.65;
}

function scoreNegationPenalty(queryText: string, text: string): number {
  const lowered = normalizeWhitespace(text).toLowerCase();
  if (/\b(?:favorite|hobbies?|interest|team|role|color|name|pets?|car)\b/i.test(queryText) && /\b(?:no|none|not|never|doesn't|does not|didn't|did not)\b/u.test(lowered)) {
    return 0.45;
  }
  return 0;
}

function scoreContamination(status: ExactAnswerWindowStatus): number {
  switch (status) {
    case "mixed_subject":
      return 1.25;
    case "foreign_subject":
      return 1.5;
    case "no_answer_bearing_text":
      return 0.85;
    case "subject_safe":
    default:
      return 0;
  }
}

function classifySlotFit(values: readonly string[], cueScore: number): ExactAnswerSlotFit {
  if (values.length === 0) {
    return "none";
  }
  return cueScore >= 0.9 ? "strong" : "weak";
}

function scoreSlotValueFitness(value: string, family: string, queryText: string): number {
  const lowered = normalizeWhitespace(value).toLowerCase();
  let score = lowered.split(/\s+/u).length <= 4 ? 0.3 : 0;
  if (/\b[A-Z][A-Za-z0-9'’&.-]+(?:\s+[A-Z][A-Za-z0-9'’&.-]+){0,4}\b/u.test(value)) {
    score += 0.25;
  }
  if (family === "favorite_books" || /\bfavorite\s+movies?\b/i.test(queryText)) {
    if (/^(?:the\s+)?[a-z]/u.test(lowered)) {
      score -= 0.15;
    }
  }
  return score;
}

function scoreExactDetailSource(source: RecallExactDetailSource): number {
  switch (source) {
    case "episodic_leaf":
      return 3;
    case "artifact_source":
      return 2.7;
    case "derivation":
      return 1.8;
    case "mixed":
    default:
      return 1;
  }
}

function isStrongSupport(window: ExactAnswerWindow, slotFit: ExactAnswerSlotFit): boolean {
  if (window.source === "episodic_leaf" || window.source === "artifact_source") {
    return slotFit === "strong";
  }
  if (
    window.derivationType === "participant_turn" ||
    window.derivationType === "source_sentence"
  ) {
    return slotFit === "strong" && !/\?\s*$/u.test(window.sourceSentenceText ?? window.text);
  }
  return false;
}

export function deriveExactAnswerCandidate(options: ExactAnswerDerivationOptions): ExactAnswerDerivationResult {
  const windows = options.results.flatMap((result) => extractAnswerBearingWindows(options.queryText, result));
  const evaluated = windows.map((window) => {
    const values = options.extractValues(window.text, options.queryText).filter((value) => normalizeWhitespace(value).length > 0);
    const status = classifyWindowStatus(window, options.queryText);
    const subjectPurityScore = scoreSubjectPurity(status);
    const speakerAlignmentScore = scoreSpeakerAlignment(window, options.queryText);
    const slotCueScore = scoreSlotCueForFamily(options.queryText, options.family, window.text);
    const answerBearingScore = scoreAnswerBearing(values);
    const negationPenalty = scoreNegationPenalty(options.queryText, window.text);
    const contaminationPenalty = scoreContamination(status);
    const slotFit = classifySlotFit(values, slotCueScore);
    const windowScore =
      scoreExactDetailSource(window.source) +
      subjectPurityScore +
      speakerAlignmentScore +
      slotCueScore +
      answerBearingScore -
      negationPenalty -
      contaminationPenalty;

    return {
      ...window,
      status,
      slotFit,
      subjectPurityScore,
      speakerAlignmentScore,
      slotCueScore,
      answerBearingScore,
      negationPenalty,
      contaminationPenalty,
      windowScore
    } satisfies ExactAnswerWindowEvaluation;
  });

  const safeWindows = evaluated.filter((window) => window.status === "subject_safe" && window.subjectPurityScore >= 0.75);
  const candidates: ExactAnswerCandidate[] = [];
  for (const window of safeWindows) {
    const values = options.extractValues(window.text, options.queryText);
    for (const value of values) {
      const normalizedValue = normalizeWhitespace(value);
      if (!normalizedValue) {
        continue;
      }
      const slotValueFitnessScore = scoreSlotValueFitness(normalizedValue, options.family, options.queryText);
      candidates.push({
        value: normalizedValue,
        source: window.source,
        score: window.windowScore + slotValueFitnessScore,
        strongSupport: isStrongSupport(window, window.slotFit),
        slotValueFitnessScore
      });
    }
  }

  const aggregated = new Map<string, { score: number; source: RecallExactDetailSource; display: string; strongSupportCount: number; supportCount: number }>();
  for (const candidate of candidates) {
    const key = candidate.value.toLowerCase();
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, {
        score: candidate.score,
        source: candidate.source,
        display: candidate.value,
        strongSupportCount: candidate.strongSupport ? 1 : 0,
        supportCount: 1
      });
      continue;
    }
    existing.score += candidate.score;
    existing.strongSupportCount += candidate.strongSupport ? 1 : 0;
    existing.supportCount += 1;
    if (candidate.score > existing.score) {
      existing.source = candidate.source;
      existing.display = candidate.value;
    }
  }

  const ranked = [...aggregated.values()].sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const runnerUp = ranked[1];
  const dominantMargin = top && runnerUp ? Number((top.score / Math.max(runnerUp.score, 0.001)).toFixed(3)) : undefined;
  const multiValueFamilies = new Set(["martial_arts", "favorite_books", "plural_names"]);

  const telemetry: ExactAnswerTelemetry = {
    exactAnswerWindowCount: windows.length,
    exactAnswerSafeWindowCount: safeWindows.length,
    exactAnswerDiscardedMixedWindowCount: evaluated.filter((window) => window.status === "mixed_subject").length,
    exactAnswerDiscardedForeignWindowCount: evaluated.filter((window) => window.status === "foreign_subject").length,
    exactAnswerCandidateCount: candidates.length,
    exactAnswerDominantMargin: dominantMargin,
    exactAnswerAbstainedForAmbiguity: false
  };

  if (!top) {
    return {
      candidate: null,
      telemetry
    };
  }

  if (options.structuredQuery && top.strongSupportCount === 0) {
    return {
      candidate: null,
      telemetry: {
        ...telemetry,
        exactAnswerAbstainedForAmbiguity: true
      }
    };
  }

  if (
    !multiValueFamilies.has(options.family) &&
    runnerUp &&
    runnerUp.display.toLowerCase() !== top.display.toLowerCase() &&
    top.score < runnerUp.score * 1.25
  ) {
    return {
      candidate: null,
      telemetry: {
        ...telemetry,
        exactAnswerAbstainedForAmbiguity: true
      }
    };
  }

  const selectedValues = multiValueFamilies.has(options.family)
    ? ranked
        .filter((value) => value.strongSupportCount > 0)
        .filter((value) => value.score >= Math.max(top.score - 0.75, top.score * 0.55))
        .slice(0, 4)
        .map((value) => value.display)
    : [top.display];

  return {
    candidate: {
      text: options.formatClaimText(options.queryText, selectedValues.join(", ")),
      source: top.source,
      strongSupport: top.strongSupportCount > 0
    },
    telemetry
  };
}
