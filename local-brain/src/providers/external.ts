import { readConfig } from "../config.js";
import { postJson } from "./http.js";
import {
  ProviderError,
  type DeriveFromArtifactRequest,
  type DeriveFromArtifactResponse,
  type EmbedTextRequest,
  type EmbedTextResponse,
  type ProviderAdapter
} from "./types.js";

interface ExternalEmbeddingResponse {
  readonly model?: string;
  readonly embedding?: number[];
  readonly dimensions?: number;
  readonly normalized?: boolean;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly providerMetadata?: Record<string, unknown>;
}

interface ExternalDeriveResponse {
  readonly model?: string;
  readonly contentAbstract?: string;
  readonly confidenceScore?: number;
  readonly entities?: string[];
  readonly provenance?: {
    readonly artifactUri?: string;
    readonly sourceChunkId?: string;
    readonly byteOffsetStart?: number;
    readonly byteOffsetEnd?: number;
    readonly pageNumber?: number;
    readonly timestampMs?: number;
  };
  readonly providerMetadata?: Record<string, unknown>;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function createExternalAdapter(): ProviderAdapter {
  const config = readConfig();

  return {
    id: "external",
    supports: {
      textEmbedding: true,
      multimodalDerivation: true,
      modalities: ["text", "image", "pdf", "audio", "video"]
    },
    async embedText(request: EmbedTextRequest): Promise<EmbedTextResponse> {
      const started = Date.now();
      const model = request.model ?? config.externalAiEmbeddingModel;
      const result = await postJson<ExternalEmbeddingResponse>(
        "external",
        `${config.externalAiBaseUrl}${config.externalAiEmbeddingPath}`,
        {
          headers: buildHeaders(config.externalAiApiKey),
          body: {
            model,
            text: request.text,
            output_dimensionality: request.outputDimensionality ?? config.embeddingDimensions,
            metadata: request.metadata ?? {}
          }
        }
      );

      const embedding = result.data.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new ProviderError({
          provider: "external",
          code: "PROVIDER_UNKNOWN",
          message: "External AI provider returned no embedding vector"
        });
      }

      return {
        provider: "external",
        model: result.data.model ?? model,
        embedding,
        dimensions: result.data.dimensions ?? embedding.length,
        normalized: result.data.normalized ?? false,
        tokenUsage: result.data.tokenUsage,
        latencyMs: Date.now() - started,
        providerMetadata: result.data.providerMetadata
      };
    },
    async deriveFromArtifact(request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse> {
      const started = Date.now();
      const model = request.model ?? config.externalAiDeriveModel;
      const result = await postJson<ExternalDeriveResponse>(
        "external",
        `${config.externalAiBaseUrl}${config.externalAiDerivePath}`,
        {
          headers: buildHeaders(config.externalAiApiKey),
          body: {
            model,
            modality: request.modality,
            artifact_uri: request.artifactUri,
            mime_type: request.mimeType,
            max_output_tokens: request.maxOutputTokens,
            metadata: request.metadata ?? {}
          },
          timeoutMs: 120_000
        }
      );

      const contentAbstract = result.data.contentAbstract?.trim();
      if (!contentAbstract) {
        throw new ProviderError({
          provider: "external",
          code: "PROVIDER_UNKNOWN",
          message: "External AI provider returned no artifact derivation text"
        });
      }

      return {
        provider: "external",
        model: result.data.model ?? model,
        modality: request.modality,
        contentAbstract,
        confidenceScore: result.data.confidenceScore,
        entities: result.data.entities,
        provenance: result.data.provenance ?? {
          artifactUri: request.artifactUri
        },
        latencyMs: Date.now() - started,
        providerMetadata: result.data.providerMetadata
      };
    }
  };
}
