export type NamespaceId = string;
export type ArtifactId = string;
export type MemoryId = string;

export type SourceType =
  | "markdown"
  | "markdown_session"
  | "text"
  | "audio"
  | "video"
  | "transcript"
  | "pdf"
  | "image"
  | "project_note"
  | "chat_turn";

export interface ArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly namespaceId: NamespaceId;
  readonly sourceType: SourceType;
  readonly uri: string;
  readonly checksumSha256: string;
  readonly observationId?: string;
  readonly version?: number;
  readonly mimeType?: string;
  readonly sourceChannel?: string;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface FragmentRecord {
  readonly fragmentIndex: number;
  readonly sceneIndex: number;
  readonly text: string;
  readonly charStart?: number;
  readonly charEnd?: number;
  readonly speaker?: string;
  readonly confidence?: number;
  readonly occurredAt: string;
  readonly importanceScore?: number;
  readonly tags?: string[];
  readonly metadata?: Record<string, unknown>;
}

export type TimeGranularity = "instant" | "day" | "week" | "month" | "year" | "relative_duration" | "relative_recent" | "unknown";
export type TimeAnchorBasis = "explicit" | "captured_at" | "prior_scene" | "prior_event" | "fallback";

export interface SceneRecord {
  readonly sceneIndex: number;
  readonly text: string;
  readonly charStart?: number;
  readonly charEnd?: number;
  readonly rawText?: string;
  readonly speaker?: string;
  readonly utteranceIndex?: number;
  readonly utteranceStartMs?: number;
  readonly utteranceEndMs?: number;
  readonly transcriptConfidence?: number;
  readonly occurredAt: string;
  readonly sceneKind: "paragraph" | "story_event";
  readonly timeExpressionText?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly timeGranularity?: TimeGranularity;
  readonly timeConfidence?: number;
  readonly isRelativeTime?: boolean;
  readonly anchorBasis?: TimeAnchorBasis;
  readonly anchorSceneIndex?: number;
  readonly anchorConfidence?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ProvenancePointer {
  readonly artifactId: ArtifactId;
  readonly sourceChunkId?: string;
  readonly sourceOffset?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface RecallResult {
  readonly memoryId: MemoryId;
  readonly memoryType:
    | "episodic_memory"
    | "semantic_memory"
    | "procedural_memory"
    | "relationship_memory"
    | "narrative_event"
    | "memory_candidate"
    | "artifact_derivation"
    | "relationship_candidate"
    | "temporal_nodes";
  readonly content: string;
  readonly score?: number;
  readonly artifactId?: ArtifactId | null;
  readonly occurredAt?: string | null;
  readonly namespaceId: NamespaceId;
  readonly provenance: Record<string, unknown>;
}
