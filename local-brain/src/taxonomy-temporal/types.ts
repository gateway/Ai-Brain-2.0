export type ExtractionAssistantMode = "off" | "shadow" | "assist" | "strict_review";

export type TaxonomyStatus =
  | "approved"
  | "mapped_to_parent"
  | "repaired"
  | "generic_reviewable"
  | "needs_taxonomy_review"
  | "unsupported"
  | "diagnostic_only";

export type CandidateType =
  | "fact"
  | "event"
  | "relationship"
  | "task"
  | "temporal_reference"
  | "diagnostic";

export type PromotionRecommendation =
  | "promote"
  | "diagnostic_only"
  | "needs_clarification"
  | "needs_taxonomy_review";

export interface ExtractionUnit {
  readonly unitId: string;
  readonly namespaceId: string;
  readonly sourceType: string;
  readonly sourceId?: string | null;
  readonly sourceMemoryId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly sourceSceneId?: string | null;
  readonly capturedAt?: string | null;
  readonly speaker?: string | null;
  readonly unitIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly unitText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly tokenEstimate: number;
  readonly chunkingStatus: "ready" | "needs_split_review" | "empty" | "oversized";
  readonly splitReason: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ExtractionUnitBuildInput {
  readonly namespaceId: string;
  readonly sourceType: string;
  readonly sourceId?: string | null;
  readonly sourceMemoryId?: string | null;
  readonly sourceChunkId?: string | null;
  readonly sourceSceneId?: string | null;
  readonly capturedAt?: string | null;
  readonly speaker?: string | null;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ExtractionUnitBuildOptions {
  readonly maxUnitChars: number;
  readonly maxContextChars: number;
  readonly overlapSentences: number;
}

export interface TaxonomyRegistry {
  readonly version: string;
  readonly core_object_types: readonly string[];
  readonly domains: Readonly<Record<string, { readonly families: readonly string[] }>>;
  readonly families: Readonly<Record<string, { readonly subtypes: readonly string[] }>>;
  readonly temporal_types: readonly string[];
  readonly statuses: readonly string[];
  readonly review_rules?: Record<string, unknown>;
}

export interface SuggestedTaxonomy {
  readonly key?: string | null;
  readonly label?: string | null;
  readonly reason?: string | null;
}

export interface TemporalCandidatePayload {
  readonly raw_text?: string | null;
  readonly temporal_type?: string | null;
  readonly temporal_class?: string | null;
  readonly normalized_range?: {
    readonly start?: string | null;
    readonly end?: string | null;
  } | null;
  readonly normalized_duration?: string | null;
  readonly normalized_value?: string | null;
  readonly granularity?: string | null;
  readonly anchor_type?: string | null;
  readonly anchor_id?: string | null;
  readonly precision?: string | null;
  readonly answerable_shapes?: readonly string[] | null;
  readonly blocked_shapes?: readonly string[] | null;
  readonly rejection_reason?: string | null;
  readonly needs_clarification?: boolean | null;
}

export interface ConfidenceBreakdown {
  readonly gliner2?: number | null;
  readonly llm_taxonomy?: number | null;
  readonly llm_temporal?: number | null;
  readonly evidence?: number | null;
  readonly overall?: number | null;
}

export interface AssistantCandidate {
  readonly candidate_type?: CandidateType | string | null;
  readonly evidence_quote?: string | null;
  readonly evidence_family?: string | null;
  readonly answer_shape?: "atomic_value" | "list" | "date" | "duration" | "reason" | "yes_no" | "abstention" | string | null;
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly object_type?: string | null;
  readonly domain?: string | null;
  readonly family?: string | null;
  readonly subtype?: string | null;
  readonly trait_family?: string | null;
  readonly trait_value?: string | null;
  readonly polarity?: "positive" | "negative" | "ambiguous" | string | null;
  readonly temporal_anchor?: string | null;
  readonly source_span?: {
    readonly start?: number | null;
    readonly end?: number | null;
  } | null;
  readonly tags?: readonly string[] | null;
  readonly suggested_taxonomy?: SuggestedTaxonomy | null;
  readonly taxonomy_status?: TaxonomyStatus | string | null;
  readonly temporal?: TemporalCandidatePayload | null;
  readonly confidence?: ConfidenceBreakdown | null;
  readonly promotion_recommendation?: PromotionRecommendation | string | null;
}

export interface AssistantOutput {
  readonly schema_version?: string | null;
  readonly unit_id?: string | null;
  readonly candidates?: readonly AssistantCandidate[] | null;
  readonly warnings?: readonly string[] | null;
}

export interface AssistantInput {
  readonly schema_version: "taxonomy_temporal_assistant_input_v1" | "taxonomy_temporal_assistant_input_v2";
  readonly packet_version?: "assistant_packet_v2";
  readonly taxonomy_version: string;
  readonly unit: {
    readonly unit_id: string;
    readonly source_type: string;
    readonly captured_at: string | null;
    readonly speaker: string | null;
    readonly text: string;
    readonly context_before: string;
    readonly context_after: string;
    readonly text_sha256?: string;
    readonly token_estimate?: number;
  };
  readonly allowed_taxonomy: {
    readonly object_types: readonly string[];
    readonly domains: readonly string[];
    readonly families: readonly string[];
    readonly subtypes_by_family: Readonly<Record<string, readonly string[]>>;
  };
  readonly temporal_anchor_pack: {
    readonly source_captured_at: string | null;
    readonly known_birth_year: number | null;
    readonly known_events: readonly unknown[];
    readonly known_periods: readonly unknown[];
  };
  readonly gliner2_candidates: Record<string, unknown>;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly candidateIndex?: number;
}

export interface ValidatedCandidate {
  readonly candidate: AssistantCandidate;
  readonly promotionEligible: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly normalizedTemporal: ResolvedTemporalCandidate | null;
}

export interface ResolvedTemporalCandidate {
  readonly rawText: string;
  readonly temporalType: string;
  readonly temporalClass: string;
  readonly normalizedStart: string | null;
  readonly normalizedEnd: string | null;
  readonly normalizedDuration: string | null;
  readonly normalizedValue: string | null;
  readonly granularity: string;
  readonly precision: string;
  readonly anchorType: string;
  readonly anchorId: string | null;
  readonly answerableShapes: readonly string[];
  readonly blockedShapes: readonly string[];
  readonly needsClarification: boolean;
  readonly confidence: number | null;
  readonly rejectionReason: string | null;
  readonly semanticStatus: string;
  readonly semanticPayload: Record<string, unknown>;
}

export interface AssistantRunResult {
  readonly mode: ExtractionAssistantMode;
  readonly provider: "openrouter" | "deterministic";
  readonly model: string | null;
  readonly jsonValid: boolean;
  readonly skippedReason: string | null;
  readonly rawOutput: Record<string, unknown> | null;
  readonly output: AssistantOutput | null;
  readonly validationIssues: readonly ValidationIssue[];
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly latencyMs: number;
}

export interface CompilerRunResult {
  readonly unit: ExtractionUnit;
  readonly cache: {
    readonly status: "hit" | "miss" | "bypass" | "written";
    readonly cacheKey: string | null;
    readonly sourceHash: string | null;
  };
  readonly gliner2: {
    readonly attempted: boolean;
    readonly warningCount: number;
    readonly response: Record<string, unknown> | null;
    readonly error: string | null;
  };
  readonly assistant: AssistantRunResult;
  readonly candidates: readonly ValidatedCandidate[];
  readonly metrics: {
    readonly chunkBudgetPass: boolean;
    readonly jsonValidityPass: boolean;
    readonly taxonomyCompliancePass: boolean;
    readonly temporalNormalizationPass: boolean;
    readonly promotionSafetyPass: boolean;
    readonly suggestedTaxonomyCount: number;
    readonly needsClarificationCount: number;
  };
}
