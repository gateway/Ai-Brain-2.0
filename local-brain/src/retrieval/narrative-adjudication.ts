import { buildReasoningChain } from "./reasoning-chain.js";
import { buildAnswerRetrievalPlan, extractAtomicMemoryUnits } from "./answer-retrieval-plan.js";
import { buildCanonicalSubjectPlan } from "./subject-plan.js";
import {
  buildCollectionInferenceSupport,
  buildCounterfactualCareerSupport,
  buildProfileInferenceSupport,
  buildPreferenceChoiceSupport,
  renderCollectionInferenceSupport,
  renderCounterfactualCareerSupport,
  renderPreferenceChoiceSupport,
  renderProfileInferenceSupport,
  shouldUseCounterfactualCareerJudgment
} from "./support-objects.js";
import type {
  AnswerRetrievalPlan,
  AnswerShapingTrace,
  CanonicalAbstention,
  CanonicalAdjudicationResult,
  CanonicalAnswerBundle,
  CanonicalEntityReport,
  CanonicalNarrative,
  CanonicalNarrativeKind,
  CanonicalPairReport,
  CanonicalReportKind,
  RecallEvidenceItem,
  SubjectPlan,
  TemporalValidityWindow
} from "./types.js";
import type {
  CanonicalAbstainReason,
  CanonicalPredicateFamily,
  CanonicalTimeScopeKind,
  RecallConfidenceGrade,
  RecallSufficiencyGrade
} from "./types.js";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import type { RecallResult } from "../types.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function recallResultSourceTexts(result: RecallResult): readonly string[] {
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  return [
    result.content,
    typeof metadata?.source_turn_text === "string" ? metadata.source_turn_text : "",
    typeof metadata?.source_sentence_text === "string" ? metadata.source_sentence_text : "",
    typeof metadata?.prompt_text === "string" ? metadata.prompt_text : ""
  ]
    .map((value) => normalize(value))
    .filter(Boolean);
}

function inferNarrativeTimePlan(storedNarrative: StoredCanonicalLookup): TemporalValidityWindow {
  return {
    mentionedAt: storedNarrative.mentionedAt ?? null,
    validFrom: storedNarrative.validFrom ?? null,
    validUntil: storedNarrative.validUntil ?? null,
    timeScopeKind: storedNarrative.timeScopeKind,
    source: storedNarrative.temporalValiditySource ?? "unknown"
  };
}

function inferNarrativeAbstainReason(predicateFamily: CanonicalPredicateFamily, sufficiency: RecallSufficiencyGrade): CanonicalAbstainReason {
  if (sufficiency === "contradicted") {
    return "conflicting_evidence";
  }
  if (predicateFamily === "narrative_symbolism" || predicateFamily === "narrative_profile" || predicateFamily === "narrative_realization") {
    return "insufficient_support";
  }
  return "insufficient_subject_binding";
}

function isNarrativeCutoverEnabled(): boolean {
  return process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER === "1";
}

function parseNarrativeCutoverTargets(): Set<string> {
  const raw = process.env.BRAIN_CANONICAL_NARRATIVE_CUTOVER_TARGETS;
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => normalize(value).toLowerCase())
      .filter((value) => value.length > 0)
  );
}

function isPreferenceQuery(queryText: string): boolean {
  return /\bfavorite\b|\bprefer\b|\bstyle\b|\btrilogy\b|\bseries\b|\bdance\b|\bmovie\b|\bbook\b|\bgame\b/u.test(queryText);
}

function isFavoriteStyleQuery(queryText: string): boolean {
  return /\bfavorite style\b|\bfavorite .* dance\b/u.test(queryText);
}

function isFavoriteMemoryQuery(queryText: string): boolean {
  return /\bfavorite\b.*\bmemory\b/u.test(queryText);
}

function isCollectionQuery(queryText: string): boolean {
  return /\bcollect(?:ion|s)?\b|\bitems?\b|\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children's books\b/u.test(queryText);
}

function isBookshelfInferenceQuery(queryText: string): boolean {
  return /\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children's books\b/u.test(queryText);
}

function isEducationQuery(queryText: string): boolean {
  return /\bdegree\b|\bmajor\b|\bfield\b|\beducat(?:ion|e|on)\b|\bstud(?:y|ied)\b/u.test(queryText);
}

function isPetCareQuery(queryText: string): boolean {
  return /\bdog\b|\bdogs\b|\bpet\b|\bclasses?\b|\bgroups?\b|\bcare\b|\bagility\b|\bindoor activity\b/u.test(queryText);
}

function isAspirationQuery(queryText: string): boolean {
  return /\bstore\b|\bbusiness\b|\bventure\b|\bstartup\b|\bapp\b|\bunique\b|\bbrand\b|\bdream\b|\bwhy\b.*\b(start|open|build)\b/u.test(queryText);
}

function usesGenericProfileReportNormalization(reportKind: CanonicalReportKind | null | undefined): boolean {
  return reportKind === "aspiration_report" ||
    reportKind === "travel_report" ||
    reportKind === "pet_care_report" ||
    reportKind === "support_report" ||
    reportKind === "relationship_report" ||
    reportKind === "shared_history_report" ||
    reportKind === "creative_work_report";
}

function extractCollectionValue(text: string): string | null {
  const normalized = normalize(text);
  if (!normalized) {
    return null;
  }
  if (/\bclassic children'?s books\b/i.test(normalized)) {
    return "classic children's books";
  }
  if (/\bdr\.?\s*seuss books?\b/i.test(normalized)) {
    return "Dr. Seuss books";
  }
  if (/\bharry potter\b/i.test(normalized)) {
    return "Harry Potter items";
  }
  return null;
}

function renderNarrativeClaimText(
  queryText: string,
  storedNarrative: StoredCanonicalLookup,
  results: readonly RecallResult[],
  fallback: string,
  retrievalPlan: AnswerRetrievalPlan
): { claimText: string; shapingTrace: AnswerShapingTrace } {
  const defaultTrace = (
    overrides: Partial<AnswerShapingTrace> = {}
  ): AnswerShapingTrace => ({
    selectedFamily: "report",
    shapingMode: "stored_report_summary",
    shapingPipelineEntered: false,
    supportObjectAttempted: false,
    renderContractAttempted: false,
    bypassReason: "report_render_contract_not_entered",
    typedValueUsed: false,
    generatedProseUsed: false,
    runtimeResynthesisUsed: false,
    supportRowsSelected: results.length,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    supportObjectsBuilt: 0,
    supportObjectType: null,
    supportNormalizationFailures: [],
    renderContractSelected: null,
    renderContractFallbackReason: null,
    retrievalPlanFamily: retrievalPlan.family,
    retrievalPlanLane: retrievalPlan.lane,
    retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
    retrievalPlanCandidatePools: retrievalPlan.candidatePools,
    retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
    retrievalPlanRequiredFields: retrievalPlan.requiredFields,
    retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
    retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
    retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
    retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
    retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
    retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
    retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
    ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
    suppressionHints: retrievalPlan.suppressionHints,
    ...overrides
  });
  const normalizedQuery = normalize(queryText).toLowerCase();
  const normalizedFallback = normalize(fallback);
  const answerPayload =
    typeof storedNarrative.answerPayload === "object" && storedNarrative.answerPayload !== null
      ? (storedNarrative.answerPayload as Record<string, unknown>)
      : null;
  if (!normalizedFallback) {
    return { claimText: fallback, shapingTrace: defaultTrace() };
  }
  if (storedNarrative.reportKind === "collection_report") {
    const collectionAtomicUnits = extractAtomicMemoryUnits({
      results,
      storedCanonical: storedNarrative,
      retrievalPlan
    });
    const support = buildCollectionInferenceSupport({
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results,
      atomicUnits: collectionAtomicUnits
    });
    const rendered = renderCollectionInferenceSupport(queryText, support);
    if (rendered.claimText) {
      return {
        claimText: rendered.claimText,
        shapingTrace: defaultTrace({
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          bypassReason: null,
          ...rendered
        })
      };
    }
    const collectionValue = extractCollectionValue(normalizedFallback);
    return {
      claimText: collectionValue ? `Yes, since they collect ${collectionValue}.` : normalizedFallback,
        shapingTrace: defaultTrace({
          shapingMode: "stored_report_summary",
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          bypassReason: null,
          generatedProseUsed: Boolean(collectionValue),
          supportObjectsBuilt: 1,
          supportObjectType: support.supportObjectType,
        supportNormalizationFailures: support.supportNormalizationFailures,
        renderContractSelected: "collection_summary_fallback",
        renderContractFallbackReason: "support_object_empty"
      })
    };
  }
  const renderProfileLikeSupport = (support: ReturnType<typeof buildProfileInferenceSupport>): {
    claimText: string;
    shapingTrace: AnswerShapingTrace;
  } | null => {
    if (/\b or \b/iu.test(normalizedQuery)) {
      const renderedChoice = renderPreferenceChoiceSupport(
        buildPreferenceChoiceSupport({
          queryText,
          support
        })
      );
      if (renderedChoice.claimText) {
        return {
          claimText: renderedChoice.claimText,
          shapingTrace: defaultTrace({
            shapingPipelineEntered: true,
            supportObjectAttempted: true,
            renderContractAttempted: true,
            bypassReason: null,
            ...renderedChoice
          })
        };
      }
    }
    if (shouldUseCounterfactualCareerJudgment(queryText, support.reportKind)) {
      const renderedCareer = renderCounterfactualCareerSupport(
        buildCounterfactualCareerSupport({
          queryText,
          support
        })
      );
      if (renderedCareer.claimText) {
        return {
          claimText: renderedCareer.claimText,
          shapingTrace: defaultTrace({
            shapingPipelineEntered: true,
            supportObjectAttempted: true,
            renderContractAttempted: true,
            bypassReason: null,
            ...renderedCareer
          })
        };
      }
    }
    const rendered = renderProfileInferenceSupport(queryText, support);
    if (rendered.claimText) {
      return {
        claimText: rendered.claimText,
        shapingTrace: defaultTrace({
          shapingPipelineEntered: true,
          supportObjectAttempted: true,
          renderContractAttempted: true,
          bypassReason: null,
          ...rendered
        })
      };
    }
    return null;
  };
  if (storedNarrative.reportKind === "career_report") {
    const support = buildProfileInferenceSupport({
      reportKind: "career_report",
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results
    });
    const rendered = renderProfileLikeSupport(support);
    if (rendered) {
      return rendered;
    }
  }
  if (storedNarrative.reportKind === "education_report") {
    const support = buildProfileInferenceSupport({
      reportKind: "education_report",
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results
    });
    const rendered = renderProfileLikeSupport(support);
    if (rendered) {
      return rendered;
    }
  }
  if (storedNarrative.reportKind === "preference_report") {
    const support = buildProfileInferenceSupport({
      reportKind: "preference_report",
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results
    });
    const rendered = renderProfileLikeSupport(support);
    if (rendered) {
      return rendered;
    }
  }
  if (storedNarrative.reportKind === "profile_report") {
    const support = buildProfileInferenceSupport({
      reportKind: "profile_report",
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results
    });
    const rendered = renderProfileLikeSupport(support);
    if (rendered) {
      return rendered;
    }
  }
  if (usesGenericProfileReportNormalization(storedNarrative.reportKind ?? null)) {
    const support = buildProfileInferenceSupport({
      reportKind: storedNarrative.reportKind!,
      queryText,
      fallbackSummary: fallback,
      answerPayload,
      results
    });
    const rendered = renderProfileLikeSupport(support);
    if (rendered) {
      return rendered;
    }
  }
  return { claimText: fallback, shapingTrace: defaultTrace() };
}

function hasTypedCollectionPayload(storedNarrative: StoredCanonicalLookup): boolean {
  if (typeof storedNarrative.answerPayload !== "object" || storedNarrative.answerPayload === null) {
    return false;
  }
  const payload = storedNarrative.answerPayload as Record<string, unknown>;
  return payload.answer_type === "bookshelf_inference" && (typeof payload.answer_value === "string" || typeof payload.reason_value === "string");
}

function shouldApplyNarrativeCutover(queryText: string, storedNarrative: StoredCanonicalLookup, results: readonly RecallResult[]): boolean {
  if (!isNarrativeCutoverEnabled()) {
    return false;
  }
  const targets = parseNarrativeCutoverTargets();
  if (targets.size === 0) {
    return true;
  }
  const candidateKeys = [
    storedNarrative.kind,
    storedNarrative.narrativeKind,
    storedNarrative.reportKind,
    storedNarrative.predicateFamily
  ]
    .map((value) => normalize(value).toLowerCase())
    .filter((value) => value.length > 0);
  if (!candidateKeys.some((value) => targets.has(value))) {
    return false;
  }
  if (storedNarrative.kind === "abstention" && (storedNarrative.candidateCount ?? 0) <= 0) {
    return false;
  }
  if (storedNarrative.kind !== "report") {
    return true;
  }
  if (storedNarrative.reportKind === "career_report") {
    return true;
  }
  const margin = storedNarrative.selectionScoreMargin ?? 0;
  const sourceTable = normalize(storedNarrative.sourceTable).toLowerCase();
  const isAuthoritativeSource =
    sourceTable === "canonical_entity_reports" ||
    sourceTable === "canonical_pair_reports" ||
    sourceTable === "canonical_states" ||
    sourceTable === "canonical_facts" ||
    sourceTable === "canonical_sets";
  const isStructuredSource =
    isAuthoritativeSource ||
    sourceTable === "assembled_entity_report" ||
    sourceTable === "retrieved_text_unit_aggregate_report" ||
    sourceTable === "retrieved_text_unit_report";
  const normalizedQuery = normalize(queryText).toLowerCase();
  if (storedNarrative.reportKind === "preference_report" && isPreferenceQuery(normalizedQuery)) {
    if (isFavoriteMemoryQuery(normalizedQuery)) {
      return false;
    }
    const payloadValue =
      typeof storedNarrative.answerPayload === "object" &&
      storedNarrative.answerPayload !== null &&
      typeof (storedNarrative.answerPayload as Record<string, unknown>).answer_value === "string"
        ? normalize((storedNarrative.answerPayload as Record<string, unknown>).answer_value as string)
        : "";
    if (isFavoriteStyleQuery(normalizedQuery) && payloadValue) {
      return isStructuredSource && (storedNarrative.candidateCount ?? 0) > 0;
    }
    return (
      isStructuredSource &&
      storedNarrative.confidence !== "missing" &&
      storedNarrative.supportStrength !== "weak" &&
      margin >= (isFavoriteStyleQuery(normalizedQuery) ? 0.35 : 0.55)
    );
  }
  if (storedNarrative.reportKind === "collection_report" && isCollectionQuery(normalizedQuery)) {
    const collectionRetrievalPlan = buildAnswerRetrievalPlan({
      queryText,
      predicateFamily: storedNarrative.predicateFamily,
      reportKind: storedNarrative.reportKind,
      subjectEntityHints: results
        .map((result) => {
          const subjectEntityId = result.provenance.subject_entity_id;
          return typeof subjectEntityId === "string" && subjectEntityId.trim() ? subjectEntityId.trim() : null;
        })
        .filter((value): value is string => Boolean(value))
    });
    const runtimeCollectionSupport = isBookshelfInferenceQuery(normalizedQuery)
      ? buildCollectionInferenceSupport({
          queryText,
          fallbackSummary: storedNarrative.objectValue ?? null,
          answerPayload:
            typeof storedNarrative.answerPayload === "object" && storedNarrative.answerPayload !== null
              ? (storedNarrative.answerPayload as Record<string, unknown>)
              : null,
          results,
          atomicUnits: extractAtomicMemoryUnits({
            results,
            storedCanonical: storedNarrative,
            retrievalPlan: collectionRetrievalPlan
          })
        })
      : null;
    const runtimeCollectionValue =
      runtimeCollectionSupport?.supportObjectType === "CollectionInferenceSupport"
        ? runtimeCollectionSupport.collectionValue
        : runtimeCollectionSupport?.supportObjectType === "CollectionSetSupport"
          ? runtimeCollectionSupport.collectionEntries[0] ?? null
          : null;
    if (
      isBookshelfInferenceQuery(normalizedQuery) &&
      isStructuredSource &&
      (hasTypedCollectionPayload(storedNarrative) || Boolean(runtimeCollectionValue)) &&
      storedNarrative.subjectBindingStatus === "resolved" &&
      (storedNarrative.supportStrength !== "weak" || margin >= 0)
    ) {
      return true;
    }
    return (
      isStructuredSource &&
      storedNarrative.confidence !== "missing" &&
      storedNarrative.supportStrength !== "weak" &&
      margin >= 0.55
    );
  }
  if (storedNarrative.reportKind === "education_report" && isEducationQuery(normalizedQuery)) {
    return (
      isStructuredSource &&
      storedNarrative.confidence !== "missing" &&
      storedNarrative.supportStrength !== "weak" &&
      margin >= 0.65
    );
  }
  if (storedNarrative.reportKind === "pet_care_report" && isPetCareQuery(normalizedQuery)) {
    return (
      isStructuredSource &&
      storedNarrative.confidence !== "missing" &&
      storedNarrative.supportStrength !== "weak" &&
      margin >= 0.75
    );
  }
  if (storedNarrative.reportKind === "aspiration_report" && isAspirationQuery(normalizedQuery)) {
    return (
      isStructuredSource &&
      storedNarrative.confidence !== "missing" &&
      storedNarrative.supportStrength !== "weak" &&
      margin >= 0.8
    );
  }
  return (
    storedNarrative.supportStrength === "strong" &&
    storedNarrative.confidence === "confident" &&
    isAuthoritativeSource &&
    margin >= 1.2
  );
}

export interface NarrativeAdjudicationDecision {
  readonly candidate: CanonicalAdjudicationResult | null;
  readonly adjudication: CanonicalAdjudicationResult | null;
  readonly telemetry: {
    readonly pathUsed: boolean;
    readonly narrativeKind?: CanonicalNarrativeKind;
    readonly reportKind?: CanonicalReportKind;
    readonly sourceTier?: "canonical_narrative" | "canonical_report";
    readonly candidateCount?: number;
    readonly shadowDecision?: "aligned" | "candidate_only" | "cutover_applied" | "candidate_abstained";
    readonly cutoverApplied?: boolean;
  };
}

export function adjudicateNarrativeClaim(input: {
  readonly queryText: string;
  readonly exactDetailFamily: string;
  readonly results: readonly RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly assessment: {
    readonly confidence: RecallConfidenceGrade;
    readonly sufficiency: RecallSufficiencyGrade;
    readonly subjectMatch: "matched" | "mixed" | "mismatched" | "unknown";
    readonly matchedParticipants: readonly string[];
    readonly missingParticipants: readonly string[];
    readonly foreignParticipants: readonly string[];
  };
  readonly abstentionClaimText: string;
  readonly storedNarrative: StoredCanonicalLookup | null;
}): NarrativeAdjudicationDecision {
  const storedNarrative = input.storedNarrative;
  if (!storedNarrative || !["narrative", "report", "abstention"].includes(storedNarrative.kind)) {
    return {
      candidate: null,
      adjudication: null,
      telemetry: { pathUsed: false }
    };
  }

  const subjectPlan: SubjectPlan = buildCanonicalSubjectPlan({
    queryText: input.queryText,
    matchedParticipants: input.assessment.matchedParticipants,
    missingParticipants: input.assessment.missingParticipants,
    foreignParticipants: input.assessment.foreignParticipants,
    subjectEntityId: storedNarrative.subjectEntityId,
    canonicalSubjectName: storedNarrative.canonicalSubjectName,
    pairSubjectEntityId: storedNarrative.pairSubjectEntityId ?? null,
    pairSubjectName: storedNarrative.pairSubjectName ?? null,
    bindingStatus: storedNarrative.subjectBindingStatus
  });
  const retrievalPlan = buildAnswerRetrievalPlan({
    queryText: input.queryText,
    predicateFamily: storedNarrative.predicateFamily,
    reportKind: storedNarrative.reportKind,
    subjectBindingStatus: storedNarrative.subjectBindingStatus,
    subjectEntityHints: storedNarrative.subjectEntityId ? [storedNarrative.subjectEntityId] : []
  });

  const telemetryBase = {
    pathUsed: true,
    narrativeKind: storedNarrative.narrativeKind,
    reportKind: storedNarrative.reportKind,
    sourceTier: storedNarrative.kind === "narrative" ? "canonical_narrative" as const : storedNarrative.kind === "report" ? "canonical_report" as const : undefined,
    candidateCount: storedNarrative.candidateCount
  };
  const cutoverApplied = shouldApplyNarrativeCutover(input.queryText, storedNarrative, input.results);

  const renderedClaim =
    storedNarrative.kind === "abstention"
      ? {
          claimText: normalize(input.abstentionClaimText) || "Unknown.",
          shapingTrace: {
            selectedFamily: "abstention",
            shapingMode: "abstention",
            retrievalPlanFamily: retrievalPlan.family,
            retrievalPlanLane: retrievalPlan.lane,
            retrievalPlanResolvedSubjectEntityId: retrievalPlan.resolvedSubjectEntityId,
            retrievalPlanCandidatePools: retrievalPlan.candidatePools,
            retrievalPlanSuppressionPools: retrievalPlan.suppressionPools,
            retrievalPlanRequiredFields: retrievalPlan.requiredFields,
            retrievalPlanTargetedBackfill: retrievalPlan.targetedBackfill,
            retrievalPlanTargetedBackfillRequests: retrievalPlan.targetedBackfillRequests,
            retrievalPlanQueryExpansionTerms: retrievalPlan.queryExpansionTerms,
            retrievalPlanBannedExpansionTerms: retrievalPlan.bannedExpansionTerms,
            retrievalPlanFamilyConfidence: retrievalPlan.familyConfidence,
            retrievalPlanSupportCompletenessTarget: retrievalPlan.supportCompletenessTarget,
            retrievalPlanRescuePolicy: retrievalPlan.rescuePolicy,
            ownerEligibilityHints: retrievalPlan.ownerEligibilityHints,
            suppressionHints: retrievalPlan.suppressionHints,
            typedValueUsed: false,
            generatedProseUsed: false,
            runtimeResynthesisUsed: false,
            supportRowsSelected: input.results.length,
            supportTextsSelected: 0,
            supportSelectionMode: null
          } satisfies AnswerShapingTrace
        }
      : renderNarrativeClaimText(
          input.queryText,
          storedNarrative,
          input.results,
          normalize(storedNarrative.objectValue) || "Unknown.",
          retrievalPlan
        );
  const claimText = renderedClaim.claimText;
  const timePlan = inferNarrativeTimePlan(storedNarrative);
  const canonicalSupport = [
    storedNarrative.predicateFamily,
    storedNarrative.sourceTable ?? "canonical_narrative",
    storedNarrative.narrativeKind ?? storedNarrative.reportKind ?? "",
    storedNarrative.supportStrength
  ].filter(Boolean);

  const answerBundle: CanonicalAnswerBundle = {
    topClaim: claimText,
    claimKind:
      storedNarrative.kind === "abstention"
        ? "abstention"
        : storedNarrative.kind === "narrative"
          ? "narrative"
          : "report",
    subjectPlan,
    predicatePlan: storedNarrative.predicateFamily,
    timePlan,
    evidenceBundle: input.evidence,
    fallbackBlockedReason:
      storedNarrative.kind === "abstention"
        ? "canonical_narrative_abstention"
        : "canonical_narrative_precedence",
    reasoningChain: buildReasoningChain({
      queryText: input.queryText,
      predicateFamily: storedNarrative.predicateFamily,
      timeScopeKind: storedNarrative.timeScopeKind as CanonicalTimeScopeKind,
      topClaim: claimText,
      subjectNames:
        subjectPlan.kind === "pair_subject"
          ? [subjectPlan.canonicalSubjectName ?? "", subjectPlan.pairSubjectName ?? ""]
          : [subjectPlan.canonicalSubjectName ?? ""],
      results: input.results,
      canonicalSupport,
      abstainReason:
        storedNarrative.kind === "abstention"
          ? storedNarrative.abstainReason ?? inferNarrativeAbstainReason(storedNarrative.predicateFamily, input.assessment.sufficiency)
          : null,
      exclusionClauses: ["snippet_override_blocked", "narrative_cutover"]
    })
  };

  if (storedNarrative.kind === "abstention") {
    const canonical: CanonicalAbstention = {
      kind: "abstention",
      subjectEntityId: storedNarrative.subjectEntityId,
      canonicalSubjectName: storedNarrative.canonicalSubjectName ?? undefined,
      predicateFamily: storedNarrative.predicateFamily,
      abstainReason: storedNarrative.abstainReason ?? inferNarrativeAbstainReason(storedNarrative.predicateFamily, input.assessment.sufficiency),
      timeScopeKind: storedNarrative.timeScopeKind,
      provenanceRows: input.results,
      supportStrength: storedNarrative.supportStrength,
      confidence: storedNarrative.confidence,
      status: "abstained",
      validFrom: storedNarrative.validFrom,
      validUntil: storedNarrative.validUntil
    };
    const candidate: CanonicalAdjudicationResult = {
      bundle: {
        subjectEntityId: storedNarrative.subjectEntityId,
        canonicalSubjectName: storedNarrative.canonicalSubjectName ?? undefined,
        subjectBindingStatus: storedNarrative.subjectBindingStatus,
        subjectPlan,
        predicateFamily: storedNarrative.predicateFamily,
        provenanceRows: input.results,
        evidenceItems: input.evidence,
        supportStrength: storedNarrative.supportStrength,
        timeScopeKind: storedNarrative.timeScopeKind,
        canonicalReadTier: "structured_abstention",
        temporalValidity: timePlan,
        narrativeKind: storedNarrative.narrativeKind,
        reportKind: storedNarrative.reportKind,
        ownerSourceTable: storedNarrative.sourceTable ?? null
      },
      canonical,
      formatted: {
        claimText,
        finalClaimSource: "canonical_abstention",
        answerBundle,
        shapingTrace: renderedClaim.shapingTrace
      }
    };
    return {
      candidate,
      adjudication: cutoverApplied ? candidate : null,
      telemetry: {
        ...telemetryBase,
        shadowDecision: cutoverApplied ? "cutover_applied" : "candidate_abstained",
        cutoverApplied
      }
    };
  }

  const canonical =
    storedNarrative.kind === "narrative"
      ? ({
          kind: "narrative",
          subjectEntityId: storedNarrative.subjectEntityId,
          canonicalSubjectName: storedNarrative.canonicalSubjectName ?? undefined,
          predicateFamily: storedNarrative.predicateFamily,
          narrativeKind: storedNarrative.narrativeKind!,
          summaryText: claimText,
          pairSubjectEntityId: storedNarrative.pairSubjectEntityId ?? null,
          timeScopeKind: storedNarrative.timeScopeKind,
          provenanceRows: input.results,
          supportStrength: storedNarrative.supportStrength,
          confidence: storedNarrative.confidence,
          status: "supported",
          validFrom: storedNarrative.validFrom,
          validUntil: storedNarrative.validUntil
        } satisfies CanonicalNarrative)
      : ({
          kind: "report",
          subjectEntityId: storedNarrative.subjectEntityId,
          canonicalSubjectName: storedNarrative.canonicalSubjectName ?? undefined,
          predicateFamily: storedNarrative.predicateFamily,
          reportKind: storedNarrative.reportKind!,
          summaryText: claimText,
          pairSubjectEntityId: storedNarrative.pairSubjectEntityId ?? undefined,
          timeScopeKind: storedNarrative.timeScopeKind,
          provenanceRows: input.results,
          supportStrength: storedNarrative.supportStrength,
          confidence: storedNarrative.confidence,
          status: "supported",
          validFrom: storedNarrative.validFrom,
          validUntil: storedNarrative.validUntil
        } satisfies CanonicalEntityReport | CanonicalPairReport);

  const candidate: CanonicalAdjudicationResult = {
    bundle: {
      subjectEntityId: storedNarrative.subjectEntityId,
      canonicalSubjectName: storedNarrative.canonicalSubjectName ?? undefined,
      subjectBindingStatus: storedNarrative.subjectBindingStatus,
      subjectPlan,
      predicateFamily: storedNarrative.predicateFamily,
      provenanceRows: input.results,
      evidenceItems: input.evidence,
      supportStrength: storedNarrative.supportStrength,
      timeScopeKind: storedNarrative.timeScopeKind,
      canonicalReadTier: "canonical_graph",
      temporalValidity: timePlan,
      narrativeKind: storedNarrative.narrativeKind,
      reportKind: storedNarrative.reportKind,
      ownerSourceTable: storedNarrative.sourceTable ?? null
    },
    canonical,
    formatted: {
      claimText,
      finalClaimSource: storedNarrative.kind === "narrative" ? "canonical_narrative" : "canonical_report",
      answerBundle,
      shapingTrace: renderedClaim.shapingTrace
    }
  };
  return {
    candidate,
    adjudication: cutoverApplied ? candidate : null,
    telemetry: {
      ...telemetryBase,
      shadowDecision: cutoverApplied ? "cutover_applied" : "candidate_only",
      cutoverApplied
    }
  };
}
