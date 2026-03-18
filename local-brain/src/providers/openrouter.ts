import { readConfig } from "../config.js";
import { postJson } from "./http.js";
import {
  type ClassifyTextRequest,
  type ClassifyTextResponse,
  ProviderError,
  type DeriveFromArtifactRequest,
  type DeriveFromArtifactResponse,
  type EmbedTextRequest,
  type EmbedTextResponse,
  type ProviderAdapter
} from "./types.js";
import { parseJsonObjectText } from "./json.js";

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

interface OpenRouterChatResponse {
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string;
    };
  }>;
  readonly model?: string;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
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
      textClassification: true,
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
    },
    async classifyText(request: ClassifyTextRequest): Promise<ClassifyTextResponse> {
      if (!config.openRouterApiKey) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_AUTH",
          message: "OPENROUTER_API_KEY is required for OpenRouter classification requests"
        });
      }

      const model = request.model ?? config.openRouterClassifyModel;
      const started = Date.now();
      const result = await postJson<OpenRouterChatResponse>("openrouter", `${config.openRouterBaseUrl}/chat/completions`, {
        headers: {
          authorization: `Bearer ${config.openRouterApiKey}`
        },
        body: {
          model,
          response_format: {
            type: "json_object"
          },
          max_tokens: request.maxOutputTokens,
          messages: [
            ...(request.systemPrompt
              ? [
                  {
                    role: "system",
                    content: request.systemPrompt
                  }
                ]
              : []),
            {
              role: "user",
              content: request.instruction
                ? `${request.instruction}\n\nTEXT TO CLASSIFY:\n${request.text}`
                : request.text
            }
          ]
        }
      });

      const rawText = result.data.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: "OpenRouter returned no classification content"
        });
      }

      return {
        provider: "openrouter",
        model: result.data.model ?? model,
        output: parseJsonObjectText("openrouter", rawText),
        rawText,
        tokenUsage: {
          inputTokens: result.data.usage?.prompt_tokens,
          outputTokens: result.data.usage?.completion_tokens,
          totalTokens: result.data.usage?.total_tokens
        },
        latencyMs: Date.now() - started,
        providerMetadata: {
          endpoint: "chat/completions"
        }
      };
    }
  };
}
