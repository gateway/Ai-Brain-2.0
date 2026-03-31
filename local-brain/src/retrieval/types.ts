import type { NamespaceId, RecallResult } from "../types.js";

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
    readonly readerDecision?: "resolved" | "ambiguous" | "abstained_no_owned_unit" | "abstained_temporal_gap" | "abstained_alias_ambiguity";
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
    readonly vectorFallbackReason?: string;
    readonly rankingKernel?: "app_fused" | "sql_hybrid_core" | "sql_hybrid_unified";
    readonly retrievalFusionVersion?: string;
    readonly rerankerEnabled?: boolean;
    readonly rerankerVersion?: string;
    readonly lexicalCandidateCount: number;
    readonly vectorCandidateCount: number;
    readonly fusedResultCount: number;
    readonly temporalAncestorCount?: number;
    readonly temporalDescendantSupportCount?: number;
    readonly temporalGateTriggered?: boolean;
    readonly temporalLayersUsed?: readonly TemporalDescendantLayer[];
    readonly temporalSupportTokenCount?: number;
    readonly placeContainmentSupportCount?: number;
    readonly boundedEventSupportCount?: number;
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
  readonly certainty: "high" | "medium" | "low";
  readonly evidenceIds: readonly string[];
}

export interface CalendarExtractionResponse extends RecapBaseResponse {
  readonly intent: "calendar_extraction";
  readonly commitments: readonly CalendarCommitmentItem[];
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
