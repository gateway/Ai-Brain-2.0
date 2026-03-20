import type { NamespaceId, RecallResult } from "../types.js";

export interface RecallQuery {
  readonly query: string;
  readonly namespaceId: NamespaceId;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
  readonly queryEmbedding?: readonly number[];
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
}

export type RecallIntent = "simple" | "hybrid" | "complex";
export type RecallBranchPreference = "lexical_first" | "episodic_then_temporal";
export type RecallQueryClass = "direct_fact" | "temporal_summary" | "temporal_detail" | "causal" | "graph_multi_hop";
export type TemporalQueryLayer = "session" | "day" | "week" | "month" | "year" | "profile";
export type TemporalDescendantLayer = Extract<TemporalQueryLayer, "day" | "week" | "month">;
export type TemporalLayerBudgetMap = Readonly<Record<TemporalQueryLayer, number>>;
export type RecallConfidenceGrade = "confident" | "weak" | "missing";
export type RecallFollowUpAction = "none" | "suggest_verification" | "route_to_clarifications";

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

export interface RecallResponse {
  readonly results: RecallResult[];
  readonly evidence: readonly {
    readonly memoryId: string;
    readonly memoryType: RecallResult["memoryType"];
    readonly artifactId?: string | null;
    readonly occurredAt?: string | null;
    readonly sourceUri?: string | null;
    readonly snippet: string;
    readonly provenance: Record<string, unknown>;
  }[];
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
    readonly lexicalProvider: "fts" | "bm25";
    readonly lexicalFallbackUsed: boolean;
    readonly lexicalFallbackReason?: string;
    readonly queryEmbeddingSource: "provided" | "provider" | "none";
    readonly queryEmbeddingProvider?: string;
    readonly queryEmbeddingModel?: string;
    readonly vectorFallbackReason?: string;
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
      readonly reason: string;
      readonly lexicalCoverage: number;
      readonly matchedTerms: readonly string[];
      readonly totalTerms: number;
      readonly evidenceCount: number;
      readonly directEvidence: boolean;
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
    readonly planner: RecallPlan;
  };
}

export interface TimelineResponse {
  readonly timeline: RecallResult[];
}

export interface RelationshipQuery {
  readonly entityName: string;
  readonly namespaceId: NamespaceId;
  readonly predicate?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
}

export interface RelationshipResult {
  readonly relationshipId: string;
  readonly subjectName: string;
  readonly predicate: string;
  readonly objectName: string;
  readonly confidence?: number;
  readonly sourceMemoryId?: string | null;
  readonly occurredAt?: string | null;
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
