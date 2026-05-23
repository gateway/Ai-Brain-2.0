import { readFile } from "node:fs/promises";
import path from "node:path";
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
      readonly content?:
        | string
        | ReadonlyArray<{
            readonly type?: string;
            readonly text?: string;
          }>;
    };
  }>;
  readonly model?: string;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

const OPENROUTER_DERIVE_SYSTEM_PROMPT = [
  "You are a grounded multimodal extraction engine for retrieval systems.",
  "Describe only content directly observable in the artifact.",
  "Prioritize visible text, labels, covers, signage, and other OCR-like details before scene summary.",
  "Do not infer hidden facts, intentions, or context that is not visibly present.",
  "Return a JSON object with:",
  '- "content_abstract": concise factual notes suitable for search and retrieval',
  '- "entities": short visible named entities or titles',
  '- "confidence_score": number from 0 to 1'
].join(" ");

function extractChatContentText(response: OpenRouterChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function inferMimeTypeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function resolveArtifactContentUrl(request: DeriveFromArtifactRequest): Promise<string> {
  if (isHttpUrl(request.artifactUri)) {
    return request.artifactUri;
  }

  const file = await readFile(request.artifactUri);
  const mimeType = request.mimeType?.trim() || inferMimeTypeFromPath(request.artifactUri);
  return `data:${mimeType};base64,${file.toString("base64")}`;
}

function normalizeEntities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const entities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entities.push(normalized);
    if (entities.length >= 16) {
      break;
    }
  }
  return entities;
}

function normalizeConfidenceScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

export function createOpenRouterAdapter(): ProviderAdapter {
  const config = readConfig();

  return {
    id: "openrouter",
    supports: {
      textEmbedding: true,
      multimodalDerivation: true,
      textClassification: true,
      modalities: ["text", "image"]
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
    async deriveFromArtifact(request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse> {
      if (!config.openRouterApiKey) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_AUTH",
          message: "OPENROUTER_API_KEY is required for OpenRouter derivation requests"
        });
      }
      if (request.modality !== "image") {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNSUPPORTED",
          message: `OpenRouter multimodal derivation currently supports image artifacts only, received "${request.modality}".`
        });
      }

      const model = request.model ?? config.openRouterDeriveModel;
      const started = Date.now();
      const artifactContentUrl = await resolveArtifactContentUrl(request);
      const result = await postJson<OpenRouterChatResponse>("openrouter", `${config.openRouterBaseUrl}/chat/completions`, {
        headers: {
          authorization: `Bearer ${config.openRouterApiKey}`
        },
        body: {
          model,
          response_format: {
            type: "json_object"
          },
          max_tokens: request.maxOutputTokens ?? 600,
          messages: [
            {
              role: "system",
              content: OPENROUTER_DERIVE_SYSTEM_PROMPT
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'Inspect the artifact and return JSON with keys "content_abstract", "entities", and "confidence_score".'
                },
                {
                  type: "image_url",
                  image_url: {
                    url: artifactContentUrl
                  }
                }
              ]
            }
          ]
        },
        timeoutMs: 120_000
      });

      const rawText = extractChatContentText(result.data);
      if (!rawText) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: "OpenRouter returned no multimodal derivation content"
        });
      }

      const output = parseJsonObjectText("openrouter", rawText);
      const contentAbstract = typeof output.content_abstract === "string" ? output.content_abstract.trim() : "";
      if (!contentAbstract) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: "OpenRouter derivation response did not include content_abstract"
        });
      }

      return {
        provider: "openrouter",
        model: result.data.model ?? model,
        modality: request.modality,
        contentAbstract,
        confidenceScore: normalizeConfidenceScore(output.confidence_score),
        entities: normalizeEntities(output.entities),
        provenance: {
          artifactUri: request.artifactUri
        },
        latencyMs: Date.now() - started,
        providerMetadata: {
          endpoint: "chat/completions",
          raw_text: rawText
        }
      };
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
        },
        timeoutMs: request.timeoutMs
      });

      const rawText = extractChatContentText(result.data);
      if (!rawText) {
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: "OpenRouter returned no classification content"
        });
      }

      let output: Record<string, unknown>;
      try {
        output = parseJsonObjectText("openrouter", rawText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderError({
          provider: "openrouter",
          code: "PROVIDER_UNKNOWN",
          message: `${message}; raw_text_preview=${rawText.slice(0, 500)}`,
          retryable: true
        });
      }

      return {
        provider: "openrouter",
        model: result.data.model ?? model,
        output,
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
