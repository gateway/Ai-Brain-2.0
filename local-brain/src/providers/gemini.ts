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
  type ProviderAdapter,
  type ProviderModality
} from "./types.js";

interface GeminiEmbeddingResponse {
  readonly embedding?: {
    readonly values?: number[];
  };
}

const SUPPORTED_MODALITIES: ProviderModality[] = ["text", "image", "pdf", "audio", "video"];

export function createGeminiAdapter(): ProviderAdapter {
  const config = readConfig();

  return {
    id: "gemini",
    supports: {
      textEmbedding: true,
      multimodalDerivation: false,
      textClassification: false,
      modalities: SUPPORTED_MODALITIES
    },
    async embedText(request: EmbedTextRequest): Promise<EmbedTextResponse> {
      if (!config.geminiApiKey) {
        throw new ProviderError({
          provider: "gemini",
          code: "PROVIDER_AUTH",
          message: "GEMINI_API_KEY is required for Gemini embedding requests"
        });
      }

      const model = request.model ?? config.geminiEmbeddingModel;
      const started = Date.now();
      const result = await postJson<GeminiEmbeddingResponse>(
        "gemini",
        `${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(config.geminiApiKey)}`,
        {
          body: {
            content: {
              parts: [{ text: request.text }]
            },
            outputDimensionality: request.outputDimensionality ?? config.embeddingDimensions
          }
        }
      );

      const embedding = result.data.embedding?.values;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new ProviderError({
          provider: "gemini",
          code: "PROVIDER_UNKNOWN",
          message: "Gemini returned no embedding vector"
        });
      }

      return {
        provider: "gemini",
        model,
        embedding,
        dimensions: embedding.length,
        normalized: false,
        latencyMs: Date.now() - started,
        providerMetadata: {
          endpoint: "embedContent"
        }
      };
    },
    async deriveFromArtifact(request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse> {
      throw new ProviderError({
        provider: "gemini",
        code: "PROVIDER_UNSUPPORTED",
        message:
          `Gemini multimodal derivation for modality "${request.modality}" is intentionally deferred in this slice. ` +
          "Use artifact_derivations as the storage target when wiring provider-backed extraction."
      });
    },
    async classifyText(_request: ClassifyTextRequest): Promise<ClassifyTextResponse> {
      throw new ProviderError({
        provider: "gemini",
        code: "PROVIDER_UNSUPPORTED",
        message: "Gemini structured text classification is not wired in this local-first slice"
      });
    }
  };
}
