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

interface OpenRouterEmbeddingResponse {
  readonly data?: Array<{
    readonly embedding?: number[];
    readonly index?: number;
  }>;
  readonly model?: string;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
}

export function createOpenRouterAdapter(): ProviderAdapter {
  const config = readConfig();

  return {
    id: "openrouter",
    supports: {
      textEmbedding: true,
      multimodalDerivation: false,
      modalities: ["text"]
    },
    async embedText(request: EmbedTextRequest): Promise<EmbedTextResponse> {
      if (!config.openRouterApiKey) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_AUTH",
          message: "OPENROUTER_API_KEY is required for OpenRouter embedding requests"
        });
      }

      const model = request.model ?? config.openRouterEmbeddingModel;
      const started = Date.now();
      const result = await postJson<OpenRouterEmbeddingResponse>("openrouter", `${config.openRouterBaseUrl}/embeddings`, {
        headers: {
          authorization: `Bearer ${config.openRouterApiKey}`
        },
        body: {
          model,
          input: request.text,
          dimensions: request.outputDimensionality ?? config.embeddingDimensions
        }
      });

      const embedding = result.data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: "OpenRouter returned no embedding vector"
        });
      }

      return {
        provider: "openrouter",
        model: result.data.model ?? model,
        embedding,
        dimensions: embedding.length,
        normalized: false,
        tokenUsage: {
          inputTokens: result.data.usage?.prompt_tokens,
          totalTokens: result.data.usage?.total_tokens
        },
        latencyMs: Date.now() - started,
        providerMetadata: {
          endpoint: "embeddings",
          index: result.data.data?.[0]?.index ?? 0
        }
      };
    },
    async deriveFromArtifact(_request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse> {
      throw new ProviderError({
        provider: "openrouter",
        code: "PROVIDER_UNSUPPORTED",
        message: "OpenRouter multimodal derivation is not wired in this local-first slice"
      });
    }
  };
}
