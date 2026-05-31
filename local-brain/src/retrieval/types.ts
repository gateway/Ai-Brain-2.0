import type { NamespaceId, RecallResult } from "../types.js";
import type { StoredCanonicalLookup } from "../canonical-memory/service.js";
import type { RetrievalControllerIntent } from "./retrieval-controller-types.js";

export interface RecallQuery {
  readonly query: string;
  readonly namespaceId: NamespaceId;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly referenceNow?: string;
  readonly limit?: number;
  readonly queryEmbedding?: readonly number[];
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly decompositionDepth?: number;
  readonly typedLaneDescentStage?: RecallTypedLaneDescentStage;
  readonly typedLaneDescentHistory?: readonly RecallTypedLaneDescentStage[];
  readonly typedLaneInitialSufficiency?: RecallSufficiencyGrade | null;
  readonly runtimeRequestKey?: string;
}

export type RecallIntent = "simple" | "hybrid" | "complex";
export type RecallBranchPreference = "lexical_first" | "episodic_then_temporal";
export type RecallQueryClass = "direct_fact" | "temporal_summary" | "temporal_detail" | "causal" | "graph_multi_hop";
export type TemporalQueryLayer = "session" | "day" | "week" | "month" | "year" | "profile";
export type TemporalDescendantLayer = Extract<TemporalQueryLayer, "day" | "week" | "month">;
export type TemporalLayerBudgetMap = Readonly<Record<TemporalQueryLayer, number>>;
export type RecallConfidenceGrade = "confident" | "weak" | "missing";
export type RecallSufficiencyGrade = "supported" | "weak" | "missing" | "contradicted";
export type RecallSubjectMatch = "matched" | "mixed" | "mismatched" | "unknown";
export type RecallFollowUpAction = "none" | "suggest_verification" | "route_to_clarifications";
export type RecallSynthesisMode = "recall" | "reflect";
export type RecapIntent = "recap" | "task_extraction" | "calendar_extraction" | "explain_recap";
export type RecapDerivationProvider = "none" | "local" | "openrouter";
export type RecallWritebackNoteFamily = "fact_note" | "profile_note" | "preference_note";
export type RecallEntityResolutionMode = "default" | "subject_bound" | "participant_overlap";
export type RecallExactDetailSource = "episodic_leaf" | "artifact_source" | "derivation" | "mixed";
export type SupportBundleFamily =
  | "current_state"
  | "exact_detail"
  | "temporal_detail"
  | "typed_list_set"
  | "profile_report"
  | "commonality"
  | "generic";
export type RecallQueryModeHint =
  | "exact_detail"
  | "current_state"
  | "broad_profile"
  | "commonality"
  | "recap"
  | "relation_bridge"
  | "temporal_reconstruction";
export type RecallReflectEligibility = "never" | "eligible" | "preferred_if_inadequate";
export type RecallAdequacyStatus =
  | "adequate"
  | "missing_subject"
  | "mixed_subject"
  | "missing_temporal_anchor"
  | "missing_relation_bridge"
  | "missing_overlap_proof"
  | "supported_but_unshapable"
  | "insufficient_evidence"
  | "contradicted";
export type RecallMissingInfoType =
  | "subject_identity_missing"
  | "subject_isolation_missing"
  | "temporal_anchor_missing"
  | "relation_bridge_missing"
  | "overlap_proof_missing"
  | "slot_value_missing"
  | "recap_structure_missing"
  | "conflict_resolution_missing";
export type RecallReflectOutcome = "helped" | "no_gain" | "harmful";
export type RecallTypedLaneDescentStage =
  | "high_level_only"
  | "relationship_candidate"
  | "narrative_event"
  | "episodic_memory"
  | "artifact_derivation"
  | "memory_candidate";

export type CanonicalTimeScopeKind = "active" | "historical" | "range" | "anchored_relative" | "exact" | "month_year" | "before_after" | "unknown";

export type CanonicalPredicateFamily =
  | "alias_identity"
  | "profile_state"
  | "narrative_profile"
  | "narrative_motive"
  | "narrative_symbolism"
  | "narrative_realization"
  | "relationship_state"
  | "location_history"
  | "work_history"
  | "work_education_history"
  | "temporal_event_fact"
  | "ownership_binding"
  | "list_set"
  | "commonality"
  | "counterfactual"
  | "abstention"
  | "generic_fact";

export type CanonicalSupportStrength = "strong" | "moderate" | "weak";

export type CanonicalStatus = "supported" | "abstained" | "unsupported";
export type CanonicalNarrativeKind =
  | "motive"
  | "symbolism"
  | "realization"
  | "career_intent"
  | "support_reasoning"
  | "family_meaning"
  | "art_inspiration"
  | "preference_explanation";
export type CanonicalReportKind =
  | "profile_report"
  | "preference_report"
  | "education_report"
  | "collection_report"
  | "aspiration_report"
  | "travel_report"
  | "pet_care_report"
  | "career_report"
  | "support_report"
  | "relationship_report"
  | "shared_history_report"
  | "creative_work_report";

export type CanonicalSubjectBindingStatus = "resolved" | "ambiguous" | "unresolved";
export type SubjectPlanKind = "single_subject" | "pair_subject" | "ambiguous_subject" | "no_subject";
export type CanonicalReadTier = "procedural_truth" | "canonical_graph" | "structured_abstention" | "episodic_fallback";
export type TemporalValiditySource = "event_time" | "mention_time" | "mixed" | "unknown";
export type CanonicalTemporalSupportKind =
  | "explicit_event_fact"
  | "aligned_anchor"
  | "reference_derived_relative"
  | "generic_time_fragment";
export type CanonicalTemporalSourceQuality = "canonical_event" | "aligned_anchor" | "derived_relative" | "generic";
export type ProjectionTruthStatus = "active" | "superseded" | "uncertain";

export interface TemporalEventFact {
  readonly eventKey: string;
  readonly eventType: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly timeGranularity: string | null;
  readonly exactness: "exact" | "bounded" | "inferred";
  readonly truthStatus: ProjectionTruthStatus;
}

export interface TemporalEventSupport {
  readonly supportTable: string;
  readonly sourceRowId: string | null;
  readonly supportMemoryId: string | null;
  readonly supportRole: "primary" | "support" | "conflict";
  readonly snippet: string | null;
  readonly occurredAt: string | null;
}

export interface RenderPayload {
  readonly answerType?: string;
  readonly answerValue?: string;
  readonly reasonValue?: string;
  readonly itemValues?: readonly string[];
  readonly summaryText?: string;
}

export interface SqlFusedSupportCandidate {
  readonly memoryId: string;
  readonly memoryType: RecallResult["memoryType"];
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly truthStatus?: ProjectionTruthStatus;
  readonly occurredAt?: string | null;
}

export interface RenderSupportBundle {
  readonly activeSupportCount: number;
  readonly supersededSupportFilteredCount: number;
  readonly temporalExactness?: "exact" | "bounded" | "inferred" | null;
}

export interface SelectionTraceEntry {
  readonly stage: string;
  readonly decision: string;
  readonly reason: string;
  readonly selectedSections?: readonly string[];
  readonly rejectedOptions?: readonly string[];
}

export type QueryFocusMode =
  | "timeline"
  | "employers_only"
  | "advisory_only"
  | "ventures_only"
  | "roles_and_dates"
  | "source_audit";

export interface AnswerSectionSourceTrailEntry {
  readonly sourceUri?: string | null;
  readonly artifactId?: string | null;
  readonly occurredAt?: string | null;
  readonly sourceMemoryIds?: readonly string[];
  readonly sourceChunkIds?: readonly string[];
  readonly sourceSceneIds?: readonly string[];
  readonly sourceTable?: string | null;
  readonly sourceRowId?: string | null;
  readonly quote?: string | null;
}

export interface StructuredAnswerSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly evidenceCount: number;
  readonly sourceTrail: readonly AnswerSectionSourceTrailEntry[];
  readonly focusModes?: readonly QueryFocusMode[];
}

export type CanonicalAbstainReason =
  | "insufficient_subject_binding"
  | "conflicting_evidence"
  | "insufficient_temporal_anchor"
  | "ownership_not_proven"
  | "current_state_not_supported"
  | "unsupported_counterfactual_chain"
  | "insufficient_support";
export type RuntimeAbstentionReason =
  | "no_subject_binding"
  | "no_exact_value_support"
  | "support_conflict"
  | "temporal_gap"
  | "insufficient_active_truth";
export type TemporalCoverageStatus = "exact" | "bounded" | "partial" | "conflicting" | "unresolved";
export type EntityResolutionStatus = "resolved" | "ambiguous" | "unresolved";
export type StructuredSufficiencyStatus = "sufficient" | "partial" | "insufficient" | "none";
export type SelfBindingRecoveredFrom = "existing_binding" | "scalar_truth" | "event_truth" | "query_subject" | "none";
export type ClaimAdmissibilityStatus = "admissible" | "rejected" | "ambiguous";

export interface SubjectPlan {
  readonly kind: SubjectPlanKind;
  readonly subjectEntityId: string | null;
  readonly canonicalSubjectName: string | null;
  readonly pairSubjectEntityId?: string | null;
  readonly pairSubjectName?: string | null;
  readonly candidateEntityIds: readonly string[];
  readonly candidateNames: readonly string[];
  readonly reason: string;
}

export interface PairGraphPlan {
  readonly pairPlanUsed: boolean;
  readonly subjectEntityIds: readonly string[];
  readonly subjectNames: readonly string[];
  readonly sharedNeighborhoodValues: readonly string[];
  readonly relationshipJoinKinds: readonly string[];
  readonly exclusionApplied: boolean;
  readonly reason: string;
}

export interface TemporalValidityWindow {
  readonly mentionedAt?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly source: TemporalValiditySource;
}

export interface ReasoningChain {
  readonly subjectChain: readonly string[];
  readonly predicateChain: readonly string[];
  readonly temporalChain: readonly string[];
  readonly canonicalSupport: readonly string[];
  readonly provenanceIds: readonly string[];
  readonly abstentionBlockers: readonly string[];
  readonly exclusionClauses: readonly string[];
}

export interface CanonicalAnswerBundle {
  readonly topClaim: string;
  readonly claimKind: "fact" | "state" | "temporal" | "set" | "narrative" | "report" | "abstention";
  readonly subjectPlan: SubjectPlan;
  readonly predicatePlan: CanonicalPredicateFamily;
  readonly timePlan: TemporalValidityWindow;
  readonly evidenceBundle: readonly RecallEvidenceItem[];
  readonly fallbackBlockedReason?: string | null;
  readonly reasoningChain: ReasoningChain;
}

export type AnswerOwnerFamily = "report" | "temporal" | "list_set" | "exact_detail" | "abstention" | "generic";

export type RetrievalPlanLane =
  | "report"
  | "collection_inference"
  | "temporal_event"
  | "event_list"
  | "book_list"
  | "support_network"
  | "location_history"
  | "set_fact"
  | "exact_detail"
  | "abstention"
  | "generic";

export type PlannerAnswerKind =
  | "generic"
  | "report_inference"
  | "direct_attribute"
  | "direct_reason"
  | "value_slot"
  | "utterance_fact"
  | "inventory_list"
  | "location_history"
  | "list_history"
  | "event_inventory"
  | "support_network"
  | "temporal_event";

export type CandidatePoolSelection =
  | "temporal_exact_facts"
  | "temporal_aligned_anchors"
  | "temporal_event_neighbors"
  | "temporal_derived_relatives"
  | "canonical_temporal_facts"
  | "normalized_event_facts"
  | "normalized_collection_facts"
  | "temporal_results"
  | "subject_object_facts"
  | "pair_subject_neighbors"
  | "canonical_reports"
  | "report_typed_payloads"
  | "report_support"
  | "profile_report_support"
  | "education_support"
  | "collection_support"
  | "community_membership_support"
  | "career_support"
  | "preference_support"
  | "canonical_sets"
  | "event_list_support"
  | "book_list_support"
  | "support_network_support"
  | "set_entries"
  | "canonical_facts"
  | "exact_detail_results"
  | "direct_detail_support"
  | "structured_candidates"
  | "snippet_results"
  | "raw_text_fallback";

export type SuppressionPoolSelection =
  | "career_support"
  | "health_support"
  | "mental_health_support"
  | "exact_detail_support"
  | "generic_snippet_support";

export type RetrievalRescuePolicy =
  | "allow_immediate_abstention"
  | "single_targeted_rescue_before_abstention"
  | "single_targeted_rescue_before_fallback";

export interface TargetedBackfillRequest {
  readonly reason:
    | "subject_entity_missing"
    | "collection_support_missing"
    | "collection_entries_missing"
    | "preference_support_missing"
    | "education_field_missing"
    | "causal_reason_missing"
    | "pet_care_support_missing"
    | "aspiration_support_missing"
    | "travel_location_entries_missing"
    | "community_membership_support_missing"
    | "book_list_entries_missing"
    | "book_recommendation_pair_missing"
    | "event_list_entries_missing"
    | "pair_event_entries_missing"
    | "support_network_entries_missing"
    | "location_history_entries_missing"
    | "set_entries_missing"
    | "identity_support_missing"
    | "preference_value_missing"
    | "relationship_status_missing"
    | "judgment_reason_missing"
    | "exact_detail_support_missing"
    | "temporal_event_identity_missing"
    | "temporal_granularity_missing"
    | "temporal_anchor_missing"
    | "temporal_year_missing"
    | "temporal_month_missing"
    | "temporal_day_missing"
    | "temporal_event_neighbors_missing"
    | "pair_subject_binding_missing"
    | "object_binding_missing"
    | "report_payload_missing";
  readonly requiredFields: readonly string[];
  readonly candidatePool: CandidatePoolSelection | null;
  readonly maxPasses: 1;
}

export type AnswerOwnerName =
  | "canonical_report"
  | "canonical_narrative"
  | "canonical_temporal"
  | "canonical_list_set"
  | "runtime_exact_detail"
  | "canonical_exact_detail"
  | "canonical_abstention"
  | "top_snippet";

export interface ExactDetailClaimCandidate {
  readonly text: string;
  readonly source: RecallExactDetailSource;
  readonly strongSupport: boolean;
  readonly predicateFit?: boolean;
}

export interface AnswerOwnerCandidateTrace {
  readonly owner: AnswerOwnerName;
  readonly family: AnswerOwnerFamily;
  readonly eligible: boolean;
  readonly suppressed: boolean;
  readonly suppressionReason?: string;
  readonly reasonCodes: readonly string[];
  readonly subjectBindingStatus?: CanonicalSubjectBindingStatus;
  readonly subjectPlanKind?: SubjectPlanKind;
  readonly sourceTable?: string | null;
}

export interface AnswerOwnerTrace {
  readonly family: AnswerOwnerFamily;
  readonly reasonCodes: readonly string[];
  readonly resolvedSubject: {
    readonly bindingStatus?: CanonicalSubjectBindingStatus;
    readonly subjectPlanKind?: SubjectPlanKind;
    readonly subjectId?: string | null;
    readonly subjectName?: string | null;
  };
  readonly eligibleOwners: readonly AnswerOwnerName[];
  readonly suppressedOwners: readonly {
    readonly owner: AnswerOwnerName;
    readonly reason: string;
  }[];
  readonly candidates: readonly AnswerOwnerCandidateTrace[];
  readonly winner: AnswerOwnerName | null;
  readonly fallbackPath: readonly string[];
  readonly abstentionReason?: CanonicalAbstainReason | null;
}

export type AnswerShapingMode =
  | "typed_report_payload"
  | "runtime_report_resynthesis"
  | "stored_report_summary"
  | "typed_temporal_event"
  | "typed_list_set"
  | "temporal_text_fallback"
  | "typed_set_entries"
  | "mixed_string_set"
  | "stored_canonical_fact"
  | "support_span_extraction"
  | "snippet_fallback"
  | "abstention";

export interface AnswerShapingTrace {
  readonly selectedFamily: AnswerOwnerFamily;
  readonly shapingMode: AnswerShapingMode;
  readonly winnerTier?: CanonicalWinnerTier | null;
  readonly tieBreakReason?: CanonicalTieBreakReason | null;
  readonly bindingSatisfied?: boolean;
  readonly structuredPayloadKind?: string | null;
  readonly usedDualityFallback?: boolean;
  readonly latencyBudgetFamily?: string | null;
  readonly earlyExitReason?: string | null;
  readonly retrievalPlanFamily?: AnswerOwnerFamily | "generic";
  readonly retrievalPlanLane?: RetrievalPlanLane;
  readonly retrievalPlanResolvedSubjectEntityId?: string | null;
  readonly retrievalPlanCandidatePools?: readonly string[];
  readonly retrievalPlanSuppressionPools?: readonly string[];
  readonly retrievalPlanSubjectNames?: readonly string[];
  readonly retrievalPlanTargetedFields?: readonly string[];
  readonly retrievalPlanRequiredFields?: readonly string[];
  readonly retrievalPlanTargetedBackfill?: readonly string[];
  readonly retrievalPlanTargetedBackfillRequests?: readonly TargetedBackfillRequest[];
  readonly retrievalPlanQueryExpansionTerms?: readonly string[];
  readonly retrievalPlanBannedExpansionTerms?: readonly string[];
  readonly retrievalPlanFamilyConfidence?: number;
  readonly retrievalPlanSupportCompletenessTarget?: number;
  readonly retrievalPlanRescuePolicy?: RetrievalRescuePolicy;
  readonly ownerEligibilityHints?: readonly string[];
  readonly suppressionHints?: readonly string[];
  readonly shapingPipelineEntered?: boolean;
  readonly supportObjectAttempted?: boolean;
  readonly renderContractAttempted?: boolean;
  readonly bypassReason?: string | null;
  readonly targetedRetrievalAttempted?: boolean;
  readonly targetedRetrievalReason?: string | null;
  readonly targetedFieldsRequested?: readonly string[];
  readonly targetedRetrievalSatisfied?: boolean;
  readonly plannerTargetedBackfillApplied?: boolean;
  readonly plannerTargetedBackfillReason?: string;
  readonly plannerTargetedBackfillSubqueries?: readonly string[];
  readonly plannerTargetedBackfillSatisfied?: boolean;
  readonly typedValueUsed: boolean;
  readonly generatedProseUsed: boolean;
  readonly runtimeResynthesisUsed: boolean;
  readonly supportRowsSelected: number;
  readonly supportTextsSelected?: number;
  readonly supportSelectionMode?: string | null;
  readonly supportObjectsBuilt?: number;
  readonly supportObjectType?: string | null;
  readonly supportNormalizationFailures?: readonly string[];
  readonly renderContractSelected?: string | null;
  readonly renderContractFallbackReason?: string | null;
  readonly subjectBindingStatus?: CanonicalSubjectBindingStatus;
  readonly subjectBindingReason?: string | null;
  readonly temporalEventIdentityStatus?: string | null;
  readonly temporalGranularityStatus?: string | null;
  readonly relativeAnchorStatus?: string | null;
  readonly selectedEventKey?: string | null;
  readonly selectedEventType?: string | null;
  readonly selectedTimeGranularity?: string | null;
  readonly typedSetEntryCount?: number;
  readonly typedSetEntryType?: string | null;
  readonly exactDetailSource?: RecallExactDetailSource | null;
  readonly atomicUnitCount?: number;
  readonly atomicUnitTypes?: readonly string[];
}

export interface CanonicalEvidenceBundle {
  readonly subjectEntityId: string | null;
  readonly canonicalSubjectName?: string | null;
  readonly subjectBindingStatus?: CanonicalSubjectBindingStatus;
  readonly subjectPlan?: SubjectPlan;
  readonly pairGraphPlan?: PairGraphPlan | null;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly provenanceRows: readonly RecallResult[];
  readonly evidenceItems: readonly RecallEvidenceItem[];
  readonly supportStrength: CanonicalSupportStrength;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly canonicalReadTier?: CanonicalReadTier;
  readonly temporalValidity?: TemporalValidityWindow;
  readonly narrativeKind?: CanonicalNarrativeKind;
  readonly reportKind?: CanonicalReportKind;
  readonly ownerSourceTable?: string | null;
}

interface CanonicalBase {
  readonly subjectEntityId: string | null;
  readonly canonicalSubjectName?: string | null;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly provenanceRows: readonly RecallResult[];
  readonly supportStrength: CanonicalSupportStrength;
  readonly confidence: RecallConfidenceGrade;
  readonly status: CanonicalStatus;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly supersedes?: string | null;
  readonly supersededBy?: string | null;
}

export interface CanonicalFact extends CanonicalBase {
  readonly kind: "fact";
  readonly objectValue?: string | null;
  readonly objectEntityId?: string | null;
}

export interface CanonicalState extends CanonicalBase {
  readonly kind: "state";
  readonly objectValue: string;
}

export interface CanonicalTemporalFact extends CanonicalBase {
  readonly kind: "temporal_fact";
  readonly objectValue: string;
  readonly supportKind?: CanonicalTemporalSupportKind | null;
  readonly bindingConfidence?: number | null;
  readonly temporalSourceQuality?: CanonicalTemporalSourceQuality | null;
  readonly derivedFromReference?: boolean;
  readonly eventSurfaceText?: string | null;
  readonly locationSurfaceText?: string | null;
  readonly participantEntityIds?: readonly string[];
  readonly anchorText?: string | null;
  readonly eventKey?: string | null;
  readonly eventType?: string | null;
  readonly timeGranularity?: string | null;
  readonly answerYear?: number | null;
  readonly answerMonth?: number | null;
  readonly answerDay?: number | null;
  readonly objectEntityId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly sourceEventId?: string | null;
  readonly anchorEventKey?: string | null;
  readonly anchorRelation?: string | null;
  readonly anchorOffsetValue?: number | null;
  readonly anchorOffsetUnit?: string | null;
  readonly canonicalConfidence?: number | null;
}

export interface AtomicMemoryUnit {
  readonly id: string;
  readonly namespace?: string | null;
  readonly unitType: string;
  readonly memoryId?: string | null;
  readonly artifactId?: string | null;
  readonly sourceArtifactId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly sourceUri?: string | null;
  readonly subjectEntityId?: string | null;
  readonly objectEntityId?: string | null;
  readonly sourceText: string;
  readonly canonicalText?: string | null;
  readonly eventKey?: string | null;
  readonly eventType?: string | null;
  readonly supportKind?: CanonicalTemporalSupportKind | null;
  readonly bindingConfidence?: number | null;
  readonly temporalSourceQuality?: CanonicalTemporalSourceQuality | null;
  readonly derivedFromReference?: boolean;
  readonly eventSurfaceText?: string | null;
  readonly locationSurfaceText?: string | null;
  readonly participantEntityIds?: readonly string[];
  readonly answerYear?: number | null;
  readonly answerMonth?: number | null;
  readonly answerDay?: number | null;
  readonly absoluteDate?: {
    readonly year?: number | null;
    readonly month?: number | null;
    readonly day?: number | null;
  } | null;
  readonly anchorEventKey?: string | null;
  readonly anchorRelation?: string | null;
  readonly anchorOffsetValue?: number | null;
  readonly anchorOffsetUnit?: string | null;
  readonly relativeAnchor?: {
    readonly anchorEventKey?: string | null;
    readonly relation?: string | null;
    readonly offsetValue?: number | null;
    readonly offsetUnit?: string | null;
  } | null;
  readonly confidence?: number | null;
  readonly cueTypes?: readonly string[];
  readonly supportClass?: string | null;
  readonly lexicalMatchTerms?: readonly string[];
  readonly plannerFamily?: RetrievalPlanLane | AnswerOwnerFamily | "generic";
}

export interface TemporalEventFactSupportUnit extends AtomicMemoryUnit {
  readonly unitType: "TemporalEventFactSupportUnit";
  readonly eventKey: string | null;
  readonly eventType: string | null;
  readonly supportKind: CanonicalTemporalSupportKind | null;
  readonly bindingConfidence: number | null;
  readonly temporalSourceQuality: CanonicalTemporalSourceQuality | null;
  readonly derivedFromReference: boolean;
  readonly answerYear: number | null;
  readonly answerMonth: number | null;
  readonly answerDay: number | null;
  readonly timeGranularity: string | null;
  readonly anchorEventKey: string | null;
  readonly anchorRelation: string | null;
  readonly anchorOffsetValue: number | null;
  readonly anchorOffsetUnit: string | null;
}

export interface DirectDetailSupportUnit extends AtomicMemoryUnit {
  readonly unitType: "DirectDetailSupportUnit";
  readonly exactDetailSource: RecallExactDetailSource | "unknown";
}

export interface AnswerRetrievalPlan {
  readonly family: AnswerOwnerFamily | "generic";
  readonly lane: RetrievalPlanLane;
  readonly answerKind: PlannerAnswerKind;
  readonly controllerIntent?: RetrievalControllerIntent;
  readonly resolvedSubjectEntityId: string | null;
  readonly resolvedObjectEntityId: string | null;
  readonly resolvedEventKey: string | null;
  readonly subjectNames: readonly string[];
  readonly objectNames: readonly string[];
  readonly pairSubjectEntityId: string | null;
  readonly pairSubjectNames: readonly string[];
  readonly candidatePools: readonly CandidatePoolSelection[];
  readonly suppressionPools: readonly SuppressionPoolSelection[];
  readonly targetedFields: readonly string[];
  readonly requiredFields: readonly string[];
  readonly targetedBackfill: readonly string[];
  readonly targetedBackfillRequests: readonly TargetedBackfillRequest[];
  readonly queryExpansionTerms: readonly string[];
  readonly bannedExpansionTerms: readonly string[];
  readonly ownerEligibilityHints: readonly string[];
  readonly suppressionHints: readonly string[];
  readonly familyConfidence: number;
  readonly supportCompletenessTarget: number;
  readonly rescuePolicy: RetrievalRescuePolicy;
  readonly reason: string;
}

export interface CanonicalSet extends CanonicalBase {
  readonly kind: "set";
  readonly objectValues: readonly string[];
}

export interface CanonicalNarrative extends CanonicalBase {
  readonly kind: "narrative";
  readonly narrativeKind: CanonicalNarrativeKind;
  readonly summaryText: string;
  readonly pairSubjectEntityId?: string | null;
}

export interface CanonicalEntityReport extends CanonicalBase {
  readonly kind: "report";
  readonly reportKind: CanonicalReportKind;
  readonly summaryText: string;
}

export interface CanonicalPairReport extends CanonicalBase {
  readonly kind: "report";
  readonly reportKind: CanonicalReportKind;
  readonly summaryText: string;
  readonly pairSubjectEntityId: string;
}

export interface CanonicalAbstention extends CanonicalBase {
  readonly kind: "abstention";
  readonly abstainReason: CanonicalAbstainReason;
}

export interface CanonicalFormatterResult {
  readonly claimText: string;
  readonly finalClaimSource:
    | "canonical_exact_detail"
    | "canonical_temporal"
    | "canonical_profile"
    | "canonical_commonality"
    | "canonical_list_set"
    | "canonical_counterfactual"
    | "canonical_narrative"
    | "canonical_report"
    | "canonical_abstention"
    | "canonical_generic";
  readonly answerBundle: CanonicalAnswerBundle;
  readonly shapingTrace?: AnswerShapingTrace;
}

export type CanonicalWinnerTier =
  | "canonical_temporal_bound"
  | "canonical_temporal_derived"
  | "canonical_structured"
  | "canonical_exact_detail"
  | "snippet_fallback";

export type CanonicalTieBreakReason =
  | "temporal_bound_over_snippet"
  | "named_subject_binding"
  | "structured_over_scalar"
  | "derived_temporal_over_stored_relative"
  | "goal_set_scope"
  | "goal_set_order_preserved"
  | "adjudicated_over_duality_snippet";

export interface RetrievalLatencyBudget {
  readonly family:
    | "exact_detail_scalar"
    | "bounded_event_detail"
    | "camping_location_history"
    | "descriptive_place_activity"
    | "commonality_aggregation"
    | "sparse_profile_inference"
    | "broad_direct_fact"
    | "relationship_profile"
    | "broad_preference_profile"
    | "support_network_reasoned"
    | "made_item_inventory"
    | "list_history"
    | "location_history"
    | "event_inventory"
    | "temporal_event"
    | "default";
  readonly maxBranchDepth: number;
  readonly maxNeighborhoodExpansions: number;
  readonly maxLeafCandidates: number;
  readonly stopOnFirstSufficient: boolean;
  readonly disableArtifactDerivationAfterSufficient: boolean;
}

export type TypedContractName =
  | "book_list"
  | "book_recommendation_pair"
  | "inventory_list"
  | "made_item_inventory"
  | "made_item_pair_inventory"
  | "location_history"
  | "camping_location_history"
  | "support_network"
  | "event_inventory"
  | "family_activity_inventory"
  | "pair_event_inventory"
  | "direct_destress_activity"
  | "direct_reason"
  | "structured_direct_reason"
  | "benefit_reason_slot"
  | "value_slot"
  | "symbolic_value_slot"
  | "direct_attribute"
  | "temporal_plan_detail"
  | "utterance_fact"
  | "pet_inventory"
  | "identity_profile"
  | "relationship_profile"
  | "preference_profile"
  | "profile_trait_judgment"
  | "reasoned_profile_judgment";

export type StructuredPredicateFamily =
  | "media.read"
  | "media.recommend"
  | "event.attend"
  | "event.plan"
  | "activity.general"
  | "activity.family"
  | "activity.hike"
  | "activity.camping"
  | "activity.workshop"
  | "creation.paint"
  | "creation.pottery"
  | "preference.general"
  | "preference.music"
  | "profile.trait"
  | "pet.own"
  | "benefit.effect"
  | "reason.start"
  | "meaning.symbolism"
  | "detail.received_for";

export interface TypedContractCompleteness {
  readonly contract: TypedContractName;
  readonly requiredFields: readonly string[];
  readonly resolvedFields: readonly string[];
  readonly missingFields: readonly string[];
  readonly complete: boolean;
  readonly stopEligible: boolean;
  readonly completenessScore: number;
  readonly backfillReason: string | null;
  readonly normalizedItemCount?: number;
  readonly newItemCount?: number;
  readonly growthStopped?: boolean;
  readonly groundedItemCount?: number;
}

export interface PairBindingVerificationResult {
  readonly required: boolean;
  readonly verified: boolean;
  readonly primarySubjectId: string | null;
  readonly primarySubjectName: string | null;
  readonly pairSubjectId: string | null;
  readonly pairSubjectName: string | null;
  readonly reason: string;
}

export type SubjectBoundAggregationScope = "primary_subject" | "dependent_group" | "pair_subject";

export interface SubjectBoundAggregationRequest {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly subjectHints: readonly string[];
  readonly limit: number;
  readonly aggregationScope?: SubjectBoundAggregationScope;
  readonly retrievalPlan: Pick<
    AnswerRetrievalPlan,
    "family" | "lane" | "answerKind" | "subjectNames" | "controllerIntent"
  >;
}

export interface SubjectBoundAggregationResult {
  readonly attempted: boolean;
  readonly rows: readonly RecallResult[];
  readonly sources: readonly ("relationship_memory" | "semantic_memory" | "canonical_states" | "memory_entity_mentions" | "episodic_memory")[];
  readonly predicateFamily: StructuredPredicateFamily | null;
  readonly pairBinding: PairBindingVerificationResult | null;
  readonly aggregationScope: SubjectBoundAggregationScope | null;
  readonly normalizedItemKeys: readonly string[];
  readonly groundedItemKeys: readonly string[];
}

export interface TemporalPlanDetailSupport {
  readonly eventKey: string | null;
  readonly planValue: string | null;
  readonly supportRows: readonly RecallResult[];
}

export interface CanonicalAdjudicationResult {
  readonly bundle: CanonicalEvidenceBundle;
  readonly canonical:
    | CanonicalFact
    | CanonicalState
    | CanonicalTemporalFact
    | CanonicalSet
    | CanonicalNarrative
    | CanonicalEntityReport
    | CanonicalPairReport
    | CanonicalAbstention;
  readonly formatted: CanonicalFormatterResult;
}

export interface CanonicalAdjudicationRequest {
  readonly queryText: string;
  readonly results: readonly RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly assessment: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "confidence" | "sufficiency" | "subjectMatch" | "matchedParticipants" | "missingParticipants" | "foreignParticipants"
  >;
  readonly exactDetailFamily: string;
  readonly exactDetailCandidateText?: string | null;
  readonly exactDetailCandidateStrongSupport?: boolean;
  readonly exactDetailCandidatePredicateFit?: boolean;
  readonly abstentionClaimText: string;
  readonly currentDatingUnknownFromEvidence?: boolean;
  readonly derived: {
    readonly temporal?: string | null;
    readonly profile?: string | null;
    readonly identity?: string | null;
    readonly commonality?: string | null;
    readonly counterfactual?: string | null;
    readonly realization?: string | null;
    readonly causal?: string | null;
    readonly goals?: string | null;
    readonly residualExact?: string | null;
    readonly residualPlaceEvent?: string | null;
    readonly descriptivePlaceActivity?: string | null;
    readonly moveFromCountry?: string | null;
    readonly genericEnumerative?: string | null;
    readonly placeShopCountry?: string | null;
    readonly symbolicGift?: string | null;
    readonly musicMedia?: string | null;
    readonly hobbies?: string | null;
    readonly petSafety?: string | null;
    readonly financialStatus?: string | null;
    readonly companionExclusion?: string | null;
    readonly shared?: string | null;
    readonly currentProject?: string | null;
    readonly purchaseSummary?: string | null;
    readonly mediaSummary?: string | null;
    readonly preferenceSummary?: string | null;
    readonly personTime?: string | null;
  };
  readonly storedCanonical?: StoredCanonicalLookup | null;
}

export interface RecallPlan {
  readonly intent: RecallIntent;
  readonly queryClass: RecallQueryClass;
  readonly temporalFocus: boolean;
  readonly leafEvidenceRequired: boolean;
  readonly inferredTimeStart?: string;
  readonly inferredTimeEnd?: string;
  readonly yearHints: readonly string[];
  readonly lexicalTerms: readonly string[];
  readonly targetLayers: readonly TemporalQueryLayer[];
  readonly descendantExpansionOrder: readonly TemporalDescendantLayer[];
  readonly maxTemporalDepth: number;
  readonly hierarchyExpansionBudget: number;
  readonly graphHopBudget: number;
  readonly ancestorLayerBudgets: TemporalLayerBudgetMap;
  readonly descendantLayerBudgets: TemporalLayerBudgetMap;
  readonly supportMemberBudget: number;
  readonly temporalSufficiencyEpisodicThreshold: number;
  readonly temporalSufficiencyTemporalThreshold: number;
  readonly temporalSupportMaxTokens: number;
  readonly branchPreference: RecallBranchPreference;
  readonly candidateLimitMultiplier: number;
  readonly episodicWeight: number;
  readonly temporalSummaryWeight: number;
}

export interface TimelineQuery {
  readonly namespaceId: NamespaceId;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly limit?: number;
}

export interface RecallEvidenceItem {
  readonly memoryId: string;
  readonly memoryType: RecallResult["memoryType"];
  readonly artifactId?: string | null;
  readonly occurredAt?: string | null;
  readonly sourceUri?: string | null;
  readonly snippet: string;
  readonly provenance: Record<string, unknown>;
}

export interface RecallResponse {
  readonly results: RecallResult[];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly duality: {
    readonly claim: {
      readonly memoryId?: string | null;
      readonly memoryType?: RecallResult["memoryType"] | null;
      readonly text: string;
      readonly occurredAt?: string | null;
      readonly artifactId?: string | null;
      readonly sourceUri?: string | null;
      readonly validFrom?: string | null;
      readonly validUntil?: string | null;
    };
    readonly evidence: readonly {
      readonly memoryId: string;
      readonly artifactId?: string | null;
      readonly sourceUri?: string | null;
      readonly snippet: string;
    }[];
    readonly confidence: RecallConfidenceGrade;
    readonly reason: string;
    readonly followUpAction: RecallFollowUpAction;
    readonly clarificationHint?: {
      readonly endpoint: string;
      readonly namespaceId: string;
      readonly query: string;
      readonly reason: string;
      readonly suggestedPrompt: string;
      readonly mcpTool?: {
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      };
    };
  };
  readonly meta: {
    readonly contractVersion: "duality_v2";
    readonly retrievalMode: "lexical" | "hybrid";
    readonly synthesisMode?: RecallSynthesisMode;
    readonly globalQueryRouted?: boolean;
    readonly summaryRoutingUsed?: boolean;
    readonly graphRoutingUsed?: boolean;
    readonly graphEvidenceCount?: number;
    readonly graphSeedKinds?: readonly string[];
    readonly recursiveReflectApplied?: boolean;
    readonly recursiveSubqueries?: readonly string[];
    readonly plannerTargetedBackfillApplied?: boolean;
    readonly plannerTargetedBackfillReason?: string;
    readonly plannerTargetedBackfillSubqueries?: readonly string[];
    readonly plannerTargetedBackfillSatisfied?: boolean;
    readonly topicRoutingUsed?: boolean;
    readonly communitySummaryUsed?: boolean;
    readonly entityResolutionMode?: RecallEntityResolutionMode;
    readonly exactDetailExtractionUsed?: boolean;
    readonly queryModeHint?: RecallQueryModeHint;
    readonly reflectEligibility?: RecallReflectEligibility;
    readonly adequacyStatus?: RecallAdequacyStatus;
    readonly missingInfoType?: RecallMissingInfoType;
    readonly preReflectAdequacyStatus?: RecallAdequacyStatus;
    readonly preReflectMissingInfoType?: RecallMissingInfoType;
    readonly reflectHelped?: boolean;
    readonly reflectOutcome?: RecallReflectOutcome;
    readonly exactAnswerWindowCount?: number;
    readonly exactAnswerSafeWindowCount?: number;
    readonly exactAnswerDiscardedMixedWindowCount?: number;
    readonly exactAnswerDiscardedForeignWindowCount?: number;
    readonly exactAnswerCandidateCount?: number;
    readonly exactAnswerDominantMargin?: number;
    readonly exactAnswerAbstainedForAmbiguity?: boolean;
    readonly answerableUnitApplied?: boolean;
    readonly answerableUnitCandidateCount?: number;
    readonly answerableUnitOwnedCount?: number;
    readonly answerableUnitMixedCount?: number;
    readonly answerableUnitForeignCount?: number;
    readonly readerApplied?: boolean;
    readonly readerDecision?:
      | "resolved"
      | "ambiguous"
      | "abstained_no_owned_unit"
      | "abstained_temporal_gap"
      | "abstained_alias_ambiguity"
      | "offline_substrate_adjudicated";
    readonly readerSelectedUnitCount?: number;
    readonly readerTopUnitType?: string;
    readonly readerDominantMargin?: number;
    readonly readerAbstainedAliasAmbiguity?: boolean;
    readonly readerAbstainedTemporalGap?: boolean;
    readonly readerUsedFallback?: boolean;
    readonly resolverApplied?: boolean;
    readonly resolverStatus?: "resolved" | "ambiguous" | "unresolved";
    readonly resolverTopMargin?: number;
    readonly ownershipWindowCount?: number;
    readonly ownershipOwnedCount?: number;
    readonly ownershipMixedCount?: number;
    readonly ownershipForeignCount?: number;
    readonly fallbackSuppressedCount?: number;
    readonly ownedWindowUsedForFinalClaim?: boolean;
    readonly subjectIsolationApplied?: boolean;
    readonly subjectIsolationOwnedCount?: number;
    readonly subjectIsolationDiscardedMixedCount?: number;
    readonly subjectIsolationDiscardedForeignCount?: number;
    readonly subjectIsolationTopResultOwned?: boolean;
    readonly noteWritebackTriggered?: boolean;
    readonly noteWritebackFamily?: RecallWritebackNoteFamily;
    readonly lexicalProvider: "fts" | "bm25";
    readonly lexicalFallbackUsed: boolean;
    readonly lexicalFallbackReason?: string;
    readonly queryEmbeddingSource: "provided" | "provider" | "none";
    readonly queryEmbeddingProvider?: string;
    readonly queryEmbeddingModel?: string;
    readonly queryEmbeddingCacheHit?: boolean;
    readonly queryEmbeddingNormalizationVersion?: string;
    readonly queryEmbeddingCacheLookupLatencyMs?: number;
    readonly queryEmbeddingProviderLatencyMs?: number;
    readonly queryEmbeddingProviderCallCount?: number;
    readonly vectorFallbackReason?: string;
    readonly vectorPolicyMode?: "preferred" | "assisted" | "guarded";
    readonly rankingKernel?: "app_fused" | "sql_hybrid_core" | "sql_hybrid_unified";
    readonly retrievalFusionVersion?: string;
    readonly rerankerEnabled?: boolean;
    readonly rerankerVersion?: string;
    readonly lexicalCandidateCount: number;
    readonly vectorCandidateCount: number;
    readonly vectorContributedToFinalSupport?: boolean;
    readonly vectorContribution?: "none" | "candidate_pool" | "final_support";
    readonly vectorBlockedReason?: string | null;
    readonly fusedResultCount: number;
    readonly temporalAncestorCount?: number;
    readonly temporalDescendantSupportCount?: number;
    readonly temporalGateTriggered?: boolean;
    readonly temporalLayersUsed?: readonly TemporalDescendantLayer[];
    readonly temporalSupportTokenCount?: number;
    readonly placeContainmentSupportCount?: number;
    readonly boundedEventSupportCount?: number;
    readonly branchPruningApplied?: boolean;
    readonly prunedBranches?: readonly string[];
    readonly stageTimingsMs?: Readonly<Record<string, number>>;
    readonly dominantStage?: string;
    readonly topStageMs?: number;
    readonly candidateCountsByStage?: Readonly<Record<string, number>>;
    readonly rowsScannedByStage?: Readonly<Record<string, number>>;
    readonly compiledLookupTried?: boolean;
    readonly proceduralLookupTried?: boolean;
    readonly relationshipFastPathTried?: boolean;
    readonly relationshipFastPathSucceeded?: boolean;
    readonly sourceBoundedReadTried?: boolean;
    readonly sourceBoundedReadSucceeded?: boolean;
    readonly semanticFallbackUsed?: boolean;
    readonly sqlHybridUsed?: boolean;
    readonly typedLaneDescentTriggered?: boolean;
    readonly plannerBackfillTriggered?: boolean;
    readonly graphExpansionTriggered?: boolean;
    readonly neighborExpansionCount?: number;
    readonly typedLaneDepth?: number;
    readonly recursiveSubqueryCount?: number;
    readonly latencyBudgetFamily?: string;
    readonly finalBudgetFamily?: string;
    readonly typedContract?: TypedContractName;
    readonly typedContractSatisfied?: boolean;
    readonly typedContractComplete?: boolean;
    readonly projectionShadowContract?: string;
    readonly projectionShadowKind?: "list" | "report" | "temporal" | "scalar";
    readonly projectionShadowComplete?: boolean;
    readonly projectionShadowStopEligible?: boolean;
    readonly projectionShadowCompletenessScore?: number;
    readonly projectionShadowEntryCount?: number;
    readonly projectionVersion?: string;
    readonly temporalFactCount?: number;
    readonly fusedKernelMode?: "shadow" | "preferred" | "required";
    readonly renderPayloadMode?: "shadow" | "preferred" | "required";
    readonly activeSupportCount?: number;
    readonly supersededSupportFilteredCount?: number;
    readonly temporalExactness?: "exact" | "bounded" | "inferred" | null;
    readonly missingTypedFields?: readonly string[];
    readonly typedBackfillMode?: "typed_completion" | "none";
    readonly plannerWideningSuppressed?: boolean;
    readonly earlyStopReason?: string;
    readonly structuredAggregationAttempted?: boolean;
    readonly structuredAggregationSource?: readonly ("relationship_memory" | "semantic_memory" | "canonical_states" | "memory_entity_mentions" | "episodic_memory")[];
    readonly structuredPredicateFamily?: StructuredPredicateFamily;
    readonly aggregationScope?: SubjectBoundAggregationScope;
    readonly pairBindingVerified?: boolean;
    readonly lexicalBridgeAttempted?: boolean;
    readonly adjudicationSuppressedFallback?: boolean;
    readonly leafTraversalTriggered?: boolean;
    readonly descentTriggered?: boolean;
    readonly descentStages?: readonly RecallTypedLaneDescentStage[];
    readonly initialLaneSufficiency?: RecallSufficiencyGrade | null;
    readonly finalLaneSufficiency?: RecallSufficiencyGrade | null;
    readonly reducerFamily?: string;
    readonly finalRouteFamily?: string;
    readonly finalClaimSource?: string;
    readonly supportBundleFamily?: SupportBundleFamily;
    readonly authoritativeSource?: string;
    readonly abstentionReason?: RuntimeAbstentionReason;
    readonly temporalCoverageStatus?: TemporalCoverageStatus;
    readonly entityResolutionStatus?: EntityResolutionStatus;
    readonly fallbackUsed?: boolean;
    readonly fallbackReason?: string;
    readonly fallbackBlockedReason?: string;
    readonly routeBudgetEnforced?: boolean;
    readonly routeBudgetExceededStages?: readonly string[];
    readonly routeBudgetDecision?: string;
    readonly plannerTargetedBackfillSubqueryLimit?: number;
    readonly structuredSufficiencyStatus?: StructuredSufficiencyStatus;
    readonly scalarTruthTried?: boolean;
    readonly eventTruthTried?: boolean;
    readonly backfillBlockedReason?: string;
    readonly selfBindingRecoveredFrom?: SelfBindingRecoveredFrom;
    readonly claimAdmissibilityStatus?: ClaimAdmissibilityStatus;
    readonly authoritativeClaimRejectedReason?: string;
    readonly factKeyLookupUsed?: boolean;
    readonly factKeyHitType?: string;
    readonly factRowSource?: string;
    readonly compiledRankScore?: number;
    readonly compiledQueryContextScore?: number;
    readonly compiledSourceAuthorityScore?: number;
    readonly compiledSelectedReason?: string;
    readonly compiledRunnerUpReason?: string;
    readonly conflictResolutionStatus?: "resolved_by_context_margin" | "ambiguous" | "not_applicable";
    readonly conflictWinnerReason?: string;
    readonly conflictRunnerUpCount?: number;
    readonly traitFamily?: string;
    readonly traitPolarity?: string;
    readonly compiledTraitLookupTried?: boolean;
    readonly compiledTraitLookupSucceeded?: boolean;
    readonly profileTraitCompiledLookupTried?: boolean;
    readonly profileTraitCompiledLookupStatus?: string;
    readonly traitEvidenceSource?: string;
    readonly traitReaderDecision?: string;
    readonly traitRejectionReason?: string;
    readonly canonicalReportFallbackReason?: string;
    readonly profileTraitSourceCoverageStatus?: string;
    readonly profileTraitEvidenceSpanCount?: number;
    readonly profileTraitCompilerStatus?: string;
    readonly profileTraitRouteStatus?: string;
    readonly profileTraitResidualOwner?: string | null;
    readonly compiledDirectFactLookupTried?: boolean;
    readonly compiledDirectFactLookupSucceeded?: boolean;
    readonly directFactFamily?: string;
    readonly compiledDirectFactCoverageStatus?: string;
    readonly compiledProfileInferenceLookupTried?: boolean;
    readonly compiledProfileInferenceLookupSucceeded?: boolean;
    readonly profileInferenceFamily?: string;
    readonly premiseCount?: number;
    readonly premiseCoverageStatus?: string;
    readonly inferenceConfidence?: number | null;
    readonly inferencePromotionStatus?: string;
    readonly inferenceRejectionReason?: string | null;
    readonly offlineSubstrateLookupTried?: boolean;
    readonly offlineSubstrateLookupSucceeded?: boolean;
    readonly offlineSubstrateSelectedRowId?: string | null;
    readonly offlineSubstrateFamily?: string;
    readonly offlineSubstrateSourceDerivedFamily?: string | null;
    readonly offlineSubstrateSourceDerivedValue?: string | null;
    readonly offlineSubstrateQueryShape?: string | null;
    readonly offlineSubstrateAnswerShape?: string | null;
    readonly offlineSubstrateEvidenceTriggers?: readonly string[];
    readonly offlineSubstratePremiseQuoteCount?: number;
    readonly offlineSubstrateSourceSessionCount?: number;
    readonly offlineSubstrateAdjudicationStatus?: string;
    readonly offlineSubstrateRowsScanned?: number;
    readonly offlineSubstrateEvidenceCount?: number;
    readonly offlineSubstrateBlockedReason?: string | null;
    readonly offlineSubstrateDiagnosticOnly?: boolean;
    readonly profileReportProjectionTried?: boolean;
    readonly profileReportProjectionSucceeded?: boolean;
    readonly profileReportProjectionVersion?: string;
    readonly profileReportProjectionEntryCount?: number;
    readonly profileReportProjectionEvidenceCount?: number;
    readonly profileReportProjectionLatencyMs?: number;
    readonly profileReportProjectionBlockedReason?: string | null;
    readonly relationshipMapProjectionTried?: boolean;
    readonly relationshipMapProjectionSucceeded?: boolean;
    readonly relationshipMapProjectionVersion?: string;
    readonly relationshipMapProjectionEntryCount?: number;
    readonly relationshipMapProjectionEvidenceCount?: number;
    readonly relationshipMapProjectionLatencyMs?: number;
    readonly relationshipMapProjectionBlockedReason?: string | null;
    readonly projectDefinitionProjectionTried?: boolean;
    readonly projectDefinitionProjectionSucceeded?: boolean;
    readonly projectDefinitionProjectionVersion?: string;
    readonly projectDefinitionProjectionEntryCount?: number;
    readonly projectDefinitionProjectionEvidenceCount?: number;
    readonly projectDefinitionProjectionLatencyMs?: number;
    readonly projectDefinitionProjectionBlockedReason?: string | null;
    readonly queryContractRouterTried?: boolean;
    readonly queryContractRouterSucceeded?: boolean;
    readonly queryContractName?: string;
    readonly queryContractFamily?: string;
    readonly queryContractRetrievalDomain?: string;
    readonly queryContractAnswerShape?: string;
    readonly queryContractConfidence?: number;
    readonly queryContractRoutingReasons?: readonly string[];
    readonly queryContractBlockedFallbacks?: readonly string[];
    readonly queryContractFallbackBlockedReason?: string | null;
    readonly queryContractSelectedReadModel?: string | null;
    readonly queryContractLatencyMs?: number;
    readonly memoryQueryPlanVersion?: string;
    readonly memoryQueryPlanIntent?: string;
    readonly memoryQueryPlanRetrievalDomain?: string;
    readonly memoryQueryPlanQueryContract?: string;
    readonly memoryQueryPlanAnswerShape?: string;
    readonly memoryQueryPlanSubjects?: readonly string[];
    readonly memoryQueryPlanObjects?: readonly string[];
    readonly memoryQueryPlanPlaces?: readonly string[];
    readonly memoryQueryPlanProjects?: readonly string[];
    readonly memoryQueryPlanTimeWindow?: Record<string, unknown> | null;
    readonly temporalClarificationRequired?: boolean;
    readonly temporalAmbiguityReason?: string | null;
    readonly temporalCandidateWindows?: readonly Record<string, unknown>[];
    readonly selectedTemporalAssumption?: string | null;
    readonly temporalDecomposition?: Record<string, unknown>;
    readonly temporalConstraintSet?: readonly Record<string, unknown>[];
    readonly timeNodeGranularity?: string | null;
    readonly memoryQueryPlanSourceScope?: string;
    readonly memoryQueryPlanTaskScope?: string;
    readonly memoryQueryPlanSourceAuditTarget?: Record<string, unknown> | null;
    readonly memoryQueryPlanRequiresSynthesis?: boolean;
    readonly recallChannels?: readonly string[];
    readonly rerankDecision?: string;
    readonly filterTrace?: readonly Record<string, unknown>[];
    readonly finalSelectionReason?: string;
    readonly selectedCorpusCapability?: string;
    readonly routeArbitrationDecision?: string;
    readonly routeArbitrationReason?: string;
    readonly blockedEarlyRoutes?: readonly string[];
    readonly selectedReader?: string | null;
    readonly rawTranscriptRetrievalCount?: number;
    readonly packetTokenEstimate?: number;
    readonly memoryPacketId?: string | null;
    readonly summaryNodeIds?: readonly string[];
    readonly sourceWindowIds?: readonly string[];
    readonly expandable?: boolean;
    readonly expansionTrace?: readonly Record<string, unknown>[];
    readonly expandableMemoryLatencyMs?: number;
    readonly queryTimeModelCalls?: number;
    readonly repoProjectionUsed?: boolean;
    readonly packageScriptProjectionUsed?: boolean;
    readonly repoDocScanCount?: number;
    readonly plannerEnforced?: boolean;
    readonly selectionTrace?: readonly SelectionTraceEntry[];
    readonly answerSections?: readonly StructuredAnswerSection[];
    readonly insightReport?: Record<string, unknown>;
    readonly insightType?: string;
    readonly insightVerification?: Record<string, unknown>;
    readonly insightObservations?: readonly Record<string, unknown>[];
    readonly insightExamples?: readonly Record<string, unknown>[];
    readonly insightSuggestions?: readonly Record<string, unknown>[];
    readonly insightSelectedCorpora?: readonly string[];
    readonly insightCandidateCountsByCorpus?: Record<string, number>;
    readonly sharedSocialGraphTried?: boolean;
    readonly sharedSocialGraphSucceeded?: boolean;
    readonly sharedSocialGraphEvidenceCount?: number;
    readonly sharedSocialGraphMode?: "strict_shared" | "grouped_with_overlap" | "single_owner";
    readonly sharedSocialGraphOwners?: readonly string[];
    readonly sharedSocialGraphSharedFriends?: readonly string[];
    readonly sharedSocialGraphPlaceScope?: string | null;
    readonly sharedSocialGraphLatencyMs?: number;
    readonly sharedSocialGraphBlockedReason?: string | null;
    readonly currentStatePurchaseProjectionTried?: boolean;
    readonly currentStatePurchaseProjectionSucceeded?: boolean;
    readonly currentStatePurchaseProjectionVersion?: string;
    readonly currentStatePurchaseProjectionEntryCount?: number;
    readonly currentStatePurchaseProjectionEvidenceCount?: number;
    readonly aliasCurrentStateProjectionTried?: boolean;
    readonly aliasCurrentStateProjectionSucceeded?: boolean;
    readonly aliasCurrentStateProjectionFamily?: string;
    readonly aliasCurrentStateProjectionVersion?: string;
    readonly aliasCurrentStateProjectionEntryCount?: number;
    readonly aliasCurrentStateProjectionEvidenceCount?: number;
    readonly aliasCurrentStateProjectionLatencyMs?: number;
    readonly aliasCurrentStateProjectionBlockedReason?: string | null;
    readonly recapProfileProjectionTried?: boolean;
    readonly recapProfileProjectionSucceeded?: boolean;
    readonly recapProfileProjectionFamily?: string;
    readonly recapProfileProjectionVersion?: string;
    readonly recapProfileProjectionEntryCount?: number;
    readonly recapProfileEvidenceCount?: number;
    readonly recapProfileLatencyMs?: number;
    readonly recapProfileBlockedReason?: string | null;
    readonly continuityProjectionTried?: boolean;
    readonly continuityProjectionSucceeded?: boolean;
    readonly continuityProjectionVersion?: string;
    readonly continuityProjectionEntryCount?: number;
    readonly continuityProjectionEvidenceCount?: number;
    readonly continuityProjectionLatencyMs?: number;
    readonly continuityProjectionBlockedReason?: string | null;
    readonly entityDossierTried?: boolean;
    readonly entityDossierSucceeded?: boolean;
    readonly entityDossierEntityType?: string;
    readonly telemetryCoverageStatus?: string;
    readonly sourceBoundFallbackUsed?: boolean;
    readonly queryTimeExtractorUsed?: boolean;
    readonly queryTimeGLiNEROrLLMUsed?: boolean;
    readonly canonicalFallbackBlockedReason?: string;
    readonly sourceBoundEvidenceRequired?: boolean;
    readonly sourceBoundEvidencePresent?: boolean;
    readonly readerEvidenceDisciplineStatus?: string;
    readonly readerResidualOwner?: string | null;
    readonly sourceTopicWindowBackfillUsed?: boolean;
    readonly answerOwnerTrace?: AnswerOwnerTrace;
    readonly answerShapingTrace?: AnswerShapingTrace;
    readonly fallbackSuppressedReason?: string;
    readonly canonicalPathUsed?: boolean;
    readonly canonicalPredicateFamily?: CanonicalPredicateFamily;
    readonly canonicalSupportStrength?: CanonicalSupportStrength;
    readonly canonicalAbstainReason?: CanonicalAbstainReason;
    readonly canonicalSubjectBindingStatus?: CanonicalSubjectBindingStatus;
    readonly canonicalSubjectId?: string;
    readonly canonicalSubjectName?: string;
    readonly canonicalStatus?: CanonicalStatus;
    readonly subjectPlanKind?: SubjectPlanKind;
    readonly pairPlanUsed?: boolean;
    readonly canonicalReadTier?: CanonicalReadTier;
    readonly temporalValiditySource?: TemporalValiditySource;
    readonly chainSerializerUsed?: boolean;
    readonly narrativePathUsed?: boolean;
    readonly narrativeKind?: CanonicalNarrativeKind;
    readonly reportPathUsed?: boolean;
    readonly reportKind?: CanonicalReportKind;
    readonly narrativeSourceTier?: "canonical_narrative" | "canonical_report";
    readonly narrativeCandidateCount?: number;
    readonly narrativeShadowDecision?: "aligned" | "candidate_only" | "cutover_applied" | "candidate_abstained";
    readonly narrativeCutoverApplied?: boolean;
    readonly temporalSummarySufficient?: boolean;
    readonly temporalDetailFocus?: boolean;
    readonly answerAssessment?: {
      readonly confidence: RecallConfidenceGrade;
      readonly sufficiency: RecallSufficiencyGrade;
      readonly reason: string;
      readonly lexicalCoverage: number;
      readonly matchedTerms: readonly string[];
      readonly totalTerms: number;
      readonly evidenceCount: number;
      readonly directEvidence: boolean;
      readonly subjectMatch: RecallSubjectMatch;
      readonly matchedParticipants: readonly string[];
      readonly missingParticipants: readonly string[];
      readonly foreignParticipants: readonly string[];
      readonly graphEvidenceUsed?: boolean;
      readonly recursiveReflectEvidenceUsed?: boolean;
      readonly summaryEvidenceUsed?: boolean;
      readonly summaryEvidenceKinds?: readonly string[];
      readonly exactDetailSource?: RecallExactDetailSource;
      readonly topicEvidenceUsed?: boolean;
      readonly communityEvidenceUsed?: boolean;
    };
    readonly followUpAction?: RecallFollowUpAction;
    readonly clarificationHint?: {
      readonly endpoint: string;
      readonly namespaceId: string;
      readonly query: string;
      readonly reason: string;
      readonly suggestedPrompt: string;
      readonly mcpTool?: {
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      };
    };
    readonly provenanceAnswer?: {
      readonly queryType: "why";
      readonly normalizedClaim: string;
      readonly distilledClaim?: string;
      readonly adjudicationReasoning?: string;
      readonly evidence: readonly {
        readonly memoryId: string;
        readonly artifactId?: string | null;
        readonly sourceUri?: string | null;
      }[];
    };
    readonly semanticAnchorResolution?: {
      readonly mode: "after" | "before" | "during";
      readonly anchorText: string;
      readonly source: "episodic_memory" | "narrative_event";
      readonly timeStart: string;
      readonly timeEnd: string;
    };
    readonly queryDecomposition?: {
      readonly applied: boolean;
      readonly subqueries: readonly string[];
    };
    readonly planner: RecallPlan;
  };
}

export interface TimelineResponse {
  readonly timeline: RecallResult[];
}

export interface RecapQuery {
  readonly query: string;
  readonly namespaceId: NamespaceId;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly referenceNow?: string;
  readonly limit?: number;
  readonly decompositionDepth?: number;
  readonly participants?: readonly string[];
  readonly topics?: readonly string[];
  readonly projects?: readonly string[];
  readonly provider?: RecapDerivationProvider;
  readonly model?: string;
}

export interface ResolvedWindow {
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly label?: string;
  readonly source: "explicit" | "planner" | "none";
}

export type TemporalScopeMode = "source_scope" | "event_window_scope" | "lifecycle_scope";

export interface RecapFocus {
  readonly participants: readonly string[];
  readonly topics: readonly string[];
  readonly projects: readonly string[];
  readonly ambiguityState: "clear" | "ambiguous" | "unknown";
}

export interface RecapRetrievalPlan {
  readonly intent: RecapIntent;
  readonly probes: readonly string[];
  readonly groupedBy: "artifact_cluster" | "day_cluster" | "result_order";
  readonly queryDecompositionApplied: boolean;
  readonly queryDecompositionSubqueries: readonly string[];
  readonly scopeMode?: TemporalScopeMode;
  readonly sourceConstraintUri?: string;
  readonly usedEventWindow?: boolean;
  readonly usedCapturedAtOnly?: boolean;
  readonly temporalSupportPaths?: readonly TemporalSupportPath[];
  readonly memoryQueryPlanVersion?: string;
  readonly memoryQueryPlanIntent?: string;
  readonly memoryQueryPlanRetrievalDomain?: string;
  readonly memoryQueryPlanQueryContract?: string;
  readonly memoryQueryPlanAnswerShape?: string;
  readonly memoryQueryPlanSubjects?: readonly string[];
  readonly memoryQueryPlanObjects?: readonly string[];
  readonly memoryQueryPlanPlaces?: readonly string[];
  readonly memoryQueryPlanProjects?: readonly string[];
  readonly memoryQueryPlanTimeWindow?: Record<string, unknown> | null;
  readonly temporalClarificationRequired?: boolean;
  readonly temporalAmbiguityReason?: string | null;
  readonly temporalCandidateWindows?: readonly Record<string, unknown>[];
  readonly selectedTemporalAssumption?: string | null;
  readonly temporalDecomposition?: Record<string, unknown>;
  readonly temporalConstraintSet?: readonly Record<string, unknown>[];
  readonly timeNodeGranularity?: string | null;
  readonly memoryQueryPlanSourceScope?: string;
  readonly memoryQueryPlanTaskScope?: string;
  readonly memoryQueryPlanSourceAuditTarget?: Record<string, unknown> | null;
  readonly memoryQueryPlanRequiresSynthesis?: boolean;
  readonly recallChannels?: readonly string[];
  readonly rerankDecision?: string;
  readonly filterTrace?: readonly Record<string, unknown>[];
  readonly finalSelectionReason?: string;
  readonly selectedCorpusCapability?: string;
  readonly routeArbitrationDecision?: string;
  readonly routeArbitrationReason?: string;
  readonly blockedEarlyRoutes?: readonly string[];
  readonly selectedReader?: string | null;
  readonly plannerEnforced?: boolean;
  readonly eventWindowBeforeTaskSelection?: boolean;
  readonly taskEventLinkDecision?: string;
  readonly taskEventLinkEvidenceKind?: readonly string[];
  readonly taskEventLinkedTaskCount?: number;
  readonly taskEventCandidateTaskCount?: number;
  readonly taskEventContextEventCount?: number;
}

export interface RecapDerivation {
  readonly provider: string;
  readonly model: string;
  readonly summaryText: string;
  readonly rawText: string;
  readonly evidenceIds: readonly string[];
  readonly latencyMs: number;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly providerMetadata?: Record<string, unknown>;
}

export interface RecapBaseResponse {
  readonly query: string;
  readonly namespaceId: NamespaceId;
  readonly intent: RecapIntent;
  readonly resolvedWindow: ResolvedWindow;
  readonly focus: RecapFocus;
  readonly confidence: RecallConfidenceGrade;
  readonly followUpAction: RecallFollowUpAction;
  readonly clarificationHint?: RecallResponse["duality"]["clarificationHint"];
  readonly evidence: readonly RecallEvidenceItem[];
  readonly retrievalPlan: RecapRetrievalPlan;
}

export interface RecapResponse extends RecapBaseResponse {
  readonly intent: "recap";
  readonly summaryBasis: "leaf_evidence" | "summary_support" | "mixed";
  readonly summaryText?: string;
  readonly derivation?: RecapDerivation;
}

export interface RecapTaskItem {
  readonly title: string;
  readonly description: string;
  readonly assigneeGuess?: string;
  readonly project?: string;
  readonly dueHint?: string;
  readonly statusGuess?: string;
  readonly lifecycleStatus?: "open" | "blocked" | "completed" | "canceled" | "superseded" | "stale_open" | "recently_closed";
  readonly statusReason?: string;
  readonly ownerSubject?: string;
  readonly dueWindowStart?: string;
  readonly dueWindowEnd?: string;
  readonly ageDays?: number;
  readonly lastMentionedAt?: string;
  readonly sourceConfidence?: "high" | "medium" | "low";
  readonly sourceTrail?: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface TaskExtractionResponse extends RecapBaseResponse {
  readonly intent: "task_extraction";
  readonly tasks: readonly RecapTaskItem[];
  readonly derivation?: RecapDerivation;
}

export interface CalendarCommitmentItem {
  readonly title: string;
  readonly participants: readonly string[];
  readonly timeHint?: string;
  readonly locationHint?: string;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly timeGranularity?: string;
  readonly timeExactness?: string;
  readonly certainty: "high" | "medium" | "low";
  readonly evidenceIds: readonly string[];
}

export interface TemporalSupportPath {
  readonly id: string;
  readonly sourceKind: string | null;
  readonly sourceUri: string | null;
  readonly capturedAt: string | null;
  readonly occurredAt: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly timeGranularity: string | null;
  readonly timeExactness: string | null;
  readonly temporalAnchorType: string | null;
  readonly temporalAnchorReference: string | null;
  readonly quote: string;
}

export interface EventMemoryUnit {
  readonly id: string;
  readonly subject: string | null;
  readonly eventType: string | null;
  readonly participants: readonly string[];
  readonly places: readonly string[];
  readonly projects: readonly string[];
  readonly capturedAt: string | null;
  readonly occurredAt: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly timeGranularity: string | null;
  readonly timeExactness: string | null;
  readonly temporalAnchorType: string | null;
  readonly temporalAnchorReference: string | null;
  readonly durationText: string | null;
  readonly durationSecondsApprox: number | null;
  readonly sourceKind: string | null;
  readonly sourceTrail: readonly string[];
}

export interface CalendarExtractionResponse extends RecapBaseResponse {
  readonly intent: "calendar_extraction";
  readonly commitments: readonly CalendarCommitmentItem[];
  readonly eventMemoryUnits?: readonly EventMemoryUnit[];
  readonly derivation?: RecapDerivation;
}

export interface ExplainRecapResponse extends RecapBaseResponse {
  readonly intent: "explain_recap";
  readonly explanation: string;
  readonly claimText?: string;
}

export interface RelationshipQuery {
  readonly entityName: string;
  readonly namespaceId: NamespaceId;
  readonly predicate?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly includeHistorical?: boolean;
  readonly limit?: number;
}

export interface RelationshipResult {
  readonly relationshipId: string;
  readonly subjectEntityId?: string | null;
  readonly objectEntityId?: string | null;
  readonly subjectName: string;
  readonly predicate: string;
  readonly objectName: string;
  readonly status?: string | null;
  readonly confidence?: number;
  readonly sourceMemoryId?: string | null;
  readonly occurredAt?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly namespaceId: NamespaceId;
  readonly provenance: Record<string, unknown>;
}

export interface RelationshipResponse {
  readonly relationships: RelationshipResult[];
}

export interface ArtifactLookupQuery {
  readonly artifactId: string;
}

export interface ArtifactObservationSummary {
  readonly observationId: string;
  readonly version: number;
  readonly checksumSha256: string;
  readonly byteSize?: number | null;
  readonly observedAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface ArtifactDerivationSummary {
  readonly derivationId: string;
  readonly derivationType: string;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly contentText?: string | null;
  readonly outputDimensionality?: number | null;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface ArtifactDetail {
  readonly artifactId: string;
  readonly namespaceId: NamespaceId;
  readonly artifactType: string;
  readonly uri: string;
  readonly latestChecksumSha256: string;
  readonly mimeType?: string | null;
  readonly sourceChannel?: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly metadata: Record<string, unknown>;
  readonly observations: readonly ArtifactObservationSummary[];
  readonly derivations: readonly ArtifactDerivationSummary[];
}
