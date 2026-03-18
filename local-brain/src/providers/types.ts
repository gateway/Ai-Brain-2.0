export type ProviderId = "openrouter" | "gemini" | "external";
export type ProviderModality = "text" | "image" | "pdf" | "audio" | "video";

export interface ProviderProvenance {
  readonly artifactUri?: string;
  readonly sourceChunkId?: string;
  readonly byteOffsetStart?: number;
  readonly byteOffsetEnd?: number;
  readonly pageNumber?: number;
  readonly timestampMs?: number;
}

export interface EmbedTextRequest {
  readonly text: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface EmbedTextResponse {
  readonly provider: ProviderId;
  readonly model: string;
  readonly embedding: number[];
  readonly dimensions: number;
  readonly normalized: boolean;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly latencyMs: number;
  readonly providerMetadata?: Record<string, unknown>;
}

export interface DeriveFromArtifactRequest {
  readonly modality: ProviderModality;
  readonly artifactUri: string;
  readonly mimeType?: string;
  readonly model?: string;
  readonly maxOutputTokens?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface DeriveFromArtifactResponse {
  readonly provider: ProviderId;
  readonly model: string;
  readonly modality: ProviderModality;
  readonly contentAbstract: string;
  readonly confidenceScore?: number;
  readonly entities?: string[];
  readonly provenance: ProviderProvenance;
  readonly latencyMs: number;
  readonly providerMetadata?: Record<string, unknown>;
}

export type ProviderErrorCode =
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_UNKNOWN";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderId;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(options: {
    readonly message: string;
    readonly code: ProviderErrorCode;
    readonly provider: ProviderId;
    readonly statusCode?: number;
    readonly retryable?: boolean;
  }) {
    super(options.message);
    this.name = "ProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly supports: {
    readonly textEmbedding: boolean;
    readonly multimodalDerivation: boolean;
    readonly modalities: ProviderModality[];
  };
  embedText(request: EmbedTextRequest): Promise<EmbedTextResponse>;
  deriveFromArtifact(request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse>;
}
