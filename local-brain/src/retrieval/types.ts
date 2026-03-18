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

export interface TimelineQuery {
  readonly namespaceId: NamespaceId;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly limit?: number;
}

export interface RecallResponse {
  readonly results: RecallResult[];
  readonly meta: {
    readonly retrievalMode: "lexical" | "hybrid";
    readonly queryEmbeddingSource: "provided" | "provider" | "none";
    readonly queryEmbeddingProvider?: string;
    readonly queryEmbeddingModel?: string;
    readonly vectorFallbackReason?: string;
    readonly lexicalCandidateCount: number;
    readonly vectorCandidateCount: number;
    readonly fusedResultCount: number;
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
