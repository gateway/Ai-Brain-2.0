import type { ArtifactRecord, FragmentRecord, NamespaceId, SceneRecord, SourceType } from "../types.js";

export interface IngestRequest {
  readonly sourceType: SourceType;
  readonly namespaceId: NamespaceId;
  readonly sessionId?: string;
  readonly capturedAt: string;
  readonly inputUri?: string;
  readonly rawText?: string;
  readonly artifactId?: string;
  readonly observationId?: string;
  readonly binaryPath?: string;
  readonly sourceChannel?: string;
  readonly metadata?: Record<string, unknown>;
  readonly scenes?: readonly SceneRecord[];
  readonly fragments?: readonly FragmentRecord[];
  readonly skipNarrativeClaims?: boolean;
}

export interface EmbeddingRequest {
  readonly fragmentId: string;
  readonly text: string;
  readonly provider: string;
  readonly model: string;
}

export interface EmbeddingResponse {
  readonly embedding: number[];
  readonly dimension: number;
  readonly providerMetadata?: Record<string, unknown>;
}

export interface CandidateMemoryWrite {
  readonly candidateType: string;
  readonly content: string;
  readonly confidence?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface IngestResult {
  readonly artifact: ArtifactRecord;
  readonly fragments: readonly FragmentRecord[];
  readonly candidateWrites: readonly CandidateMemoryWrite[];
  readonly episodicInsertCount: number;
}
