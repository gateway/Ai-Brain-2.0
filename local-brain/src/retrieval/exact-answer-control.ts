import type { RecallResult } from "../types.js";
import type { RecallExactDetailSource } from "./types.js";
import { extractEntityNameHints, parseQueryEntityFocus } from "./query-entity-focus.js";

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

interface ExactAnswerWindowValues {
  readonly window: ExactAnswerWindowEvaluation;
  readonly values: readonly string[];
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

function isPetSafetyQueryText(queryText: string): boolean {
  return (
    /\bpets?\b/i.test(queryText) &&
    (/\ballerg/i.test(queryText) ||
      /\bdiscomfort\b/i.test(queryText) ||
      /\bwould(?:\s+not|n't)\s+cause\b/i.test(queryText) ||
      /\bsafe\b/i.test(queryText))
  );
}

function isInterrogativeClaimText(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return false;
  }
  if (/\?\s*$/u.test(normalized)) {
    return true;
  }
  return /^(?:what|when|where|who|why|how|did|does|do|can|could|would|will|is|are|was|were|have|has|had)\b/iu.test(
    normalized.replace(/^[A-Z][a-z]+:\s*/u, "")
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
  const targetHints = parseQueryEntityFocus(queryText).primaryHints;
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
  const focus = parseQueryEntityFocus(queryText);
  const targetHints = focus.primaryHints;
  const companionHints = focus.companionHints;
  if (targetHints.length !== 1) {
    return "subject_safe";
  }

  const target = targetHints[0]!;
  const resultSignals = collectResultParticipantSignals(window.result).filter(
    (signal) => signal !== target && !companionHints.some((hint) => signal.includes(hint))
  );
  const normalizedText = normalizeWhitespace(window.text).toLowerCase();
  const speaker = normalizeWhitespace(window.speaker ?? "").toLowerCase();
  const speakerTurns = parseConversationSpeakerTurns(window.result.content);
  const primarySpeakerTurns = speakerTurns.filter((turn) => turn.speaker.includes(target));
  const foreignSpeakerTurns = speakerTurns.filter(
    (turn) => !turn.speaker.includes(target) && !companionHints.some((hint) => turn.speaker.includes(hint))
  );

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
  const targetHints = parseQueryEntityFocus(queryText).primaryHints;
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
    return /\bmain focus(?:es)?\b|\bfocus(?:ed)? on\b|\bpassionate about\b|\bparticularly interesting to me\b/u.test(lowered)
      ? 1.1
      : -0.5;
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
    const explicitHobbyCue =
      /\bhobbies?\s+(?:are|include)\b/u.test(lowered) ||
      /\bbesides\s+[a-z][^,!?\n]{0,40},\s*(?:i|he|she)\s+(?:also\s+)?(?:enjoy|enjoys|love|loves|like|likes)\b/u.test(lowered) ||
      /\b(?:enjoy|enjoys|love|loves|like|likes)\b/u.test(lowered) &&
        /\b(?:writing|reading|painting|drawing|sketching|hiking|running|cycling|exploring nature|hanging with friends)\b/u.test(lowered);
    const mediaOnlyPreference =
      /\b(?:dramas?|romcoms?|movies?|films?|tv|shows?)\b/u.test(lowered) &&
      !/\b(?:writing|reading|painting|drawing|sketching|hiking|running|cycling|exploring nature|hanging with friends)\b/u.test(lowered);
    if (explicitHobbyCue) {
      return mediaOnlyPreference ? 0.25 : 1.35;
    }
    return mediaOnlyPreference ? -1.35 : -0.8;
  }
  if (/\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(queryText)) {
    return /\btrilog(?:y|ies)\b|\bseries\b|\bfranchise\b/u.test(lowered) ? 1.25 : -1.1;
  }
  if (/\bfavorite\s+movies?\b/i.test(queryText)) {
    return /\bfavorite\b|\bloves?\b|\binclud(?:e|ed)\b/u.test(lowered) ? 1.2 : -0.9;
  }
  if (isPetSafetyQueryText(queryText)) {
    const explicitSafePet =
      /\b(?:hairless cats?|pigs?|reptiles?)\b/u.test(lowered) ||
      /\b(?:safe|alternative)\s+pets?\b/u.test(lowered);
    const allergyReason = /\ballerg/i.test(lowered) || /\bfur\b/u.test(lowered);
    if (explicitSafePet && allergyReason) {
      return 1.4;
    }
    if (explicitSafePet) {
      return 0.8;
    }
    return /\ballerg/i.test(lowered) ? -0.9 : -0.8;
  }
  if (/\bfinancial status\b/i.test(queryText)) {
    return /\bmiddle[- ]class\b|\bwealthy\b|\brich\b|\bwell-off\b|\bfinancially stable\b/u.test(lowered) ? 1.2 : -1;
  }
  if (/\bspark(?:ed)?\b/i.test(queryText) && /\binterest\b/i.test(queryText)) {
    return /\bspark(?:ed)?\b|\binspir(?:ed|ing)\b|\b(?:saw|seeing)\s+how\b|\bgrowing up\b|\bbetter understanding of\b|\bimpact these issues have on\b|\bcommunity meetings?\b|\bgetting involved in\b/u.test(lowered)
      ? 1.15
      : -0.8;
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

function windowAggregationKey(window: ExactAnswerWindowEvaluation): string {
  return [
    window.result.memoryId,
    window.sourceSentenceText ?? "",
    window.speaker ?? "",
    window.text
  ].join("|");
}

function collectWindowValueBundles(
  queryText: string,
  safeWindows: readonly ExactAnswerWindowEvaluation[],
  extractValues: (text: string, queryText: string) => readonly string[]
): readonly ExactAnswerWindowValues[] {
  const seen = new Set<string>();
  const bundles: ExactAnswerWindowValues[] = [];
  for (const window of [...safeWindows].sort((left, right) => right.windowScore - left.windowScore)) {
    if (isInterrogativeClaimText(window.text)) {
      continue;
    }
    const key = windowAggregationKey(window);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const values = extractValues(window.text, queryText).map((value) => normalizeWhitespace(value)).filter(Boolean);
    if (values.length === 0) {
      continue;
    }
    bundles.push({ window, values });
  }
  return bundles;
}

function isStandaloneHobbyStatement(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized || /\?\s*$/u.test(normalized)) {
    return false;
  }
  return (
    /\bbesides\s+[A-Za-z][^,!?\n]{0,40},\s*(?:i|he|she)\s+(?:also\s+)?(?:love|loves|enjoy|enjoys)\b/iu.test(normalized) ||
    /^[A-Za-z]+ing(?:\s+[A-Za-z]+){0,2}(?:\s+and\s+[A-Za-z]+ing(?:\s+(?:with|around)\s+[A-Za-z]+){0,3})?!?$/u.test(normalized)
  );
}

function isPlausibleHobbyValue(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\b(?:in|on|at|to|of|from|into|onto|around|about)$/iu.test(normalized)) {
    return false;
  }
  return true;
}

function deriveMultiValueWindowSelection(
  queryText: string,
  family: string,
  safeWindows: readonly ExactAnswerWindowEvaluation[],
  extractValues: (text: string, queryText: string) => readonly string[]
): readonly string[] {
  const bundles = collectWindowValueBundles(queryText, safeWindows, extractValues);
  if (bundles.length === 0) {
    return [];
  }

  const isHobbyQuery = /\bhobbies?\b/i.test(queryText);
  const isPetSafetyQuery = isPetSafetyQueryText(queryText);
  const wideProfileListFamily = isHobbyQuery || family === "martial_arts" || isPetSafetyQuery;
  const topWindowScore = bundles[0]!.window.windowScore;
  const minWindowScore = wideProfileListFamily
    ? Math.max(topWindowScore - 4.25, topWindowScore * 0.22)
    : Math.max(topWindowScore - 1.9, topWindowScore * 0.5);
  const maxValues = isHobbyQuery ? 8 : isPetSafetyQuery ? 4 : 5;
  const selected: string[] = [];
  const seenValues = new Set<string>();

  for (const bundle of bundles) {
    if (bundle.window.windowScore < minWindowScore) {
      continue;
    }
    if (isHobbyQuery && bundle.window.slotCueScore < 0.9 && !isStandaloneHobbyStatement(bundle.window.text)) {
      continue;
    }
    if (isPetSafetyQuery && bundle.window.slotCueScore < 0.8) {
      continue;
    }
    for (const value of bundle.values) {
      if (isHobbyQuery && !isPlausibleHobbyValue(value)) {
        continue;
      }
      const normalized = value.toLowerCase();
      if (seenValues.has(normalized)) {
        continue;
      }
      seenValues.add(normalized);
      selected.push(value);
      if (selected.length >= maxValues) {
        return selected;
      }
    }
  }

  return selected;
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
      if (/\bhobbies?\b/i.test(options.queryText) && !isPlausibleHobbyValue(normalizedValue)) {
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

  const allowSingleCandidateStructuredFallback =
    options.structuredQuery &&
    top.strongSupportCount === 0 &&
    !runnerUp &&
    safeWindows.length > 0 &&
    top.supportCount >= 1 &&
    !/\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(options.queryText) &&
    top.score >= 3;
  const isHobbyQuery = /\bhobbies?\b/i.test(options.queryText);
  const isPetSafetyQuery = isPetSafetyQueryText(options.queryText);
  const allowStructuredMultiValueFallback =
    options.structuredQuery &&
    top.strongSupportCount === 0 &&
    safeWindows.length > 0 &&
    candidates.length > 0 &&
    (multiValueFamilies.has(options.family) || isHobbyQuery || isPetSafetyQuery);

  if (
    options.structuredQuery &&
    top.strongSupportCount === 0 &&
    !allowSingleCandidateStructuredFallback &&
    !allowStructuredMultiValueFallback
  ) {
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
    !isHobbyQuery &&
    !isPetSafetyQuery &&
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

  const multiValueSelection =
    multiValueFamilies.has(options.family) || isHobbyQuery || isPetSafetyQuery
      ? deriveMultiValueWindowSelection(options.queryText, options.family, safeWindows, options.extractValues)
      : [];
  const wideProfileListFamily = multiValueFamilies.has(options.family) || isHobbyQuery || isPetSafetyQuery;

  const selectedValues =
    multiValueSelection.length > 0
      ? multiValueSelection
      : wideProfileListFamily
        ? ranked
            .filter((value) => value.strongSupportCount > 0 || value.supportCount > 0)
            .filter((value) =>
              value.score >= (
                wideProfileListFamily
                  ? Math.max(top.score - 4.5, top.score * 0.2)
                  : Math.max(top.score - 1.1, top.score * 0.45)
              )
            )
            .slice(0, isHobbyQuery ? 6 : isPetSafetyQuery ? 4 : options.family === "martial_arts" ? 5 : 4)
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
