import { readConfig } from "../config.js";
import { transcribeAudioFile } from "../ops/model-runtime.js";
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
import path from "node:path";

interface ExternalEmbeddingResponse {
  readonly model?: string;
  readonly embedding?: number[];
  readonly data?: ReadonlyArray<{
    readonly embedding?: number[];
  }>;
  readonly dimensions?: number;
  readonly normalized?: boolean;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly metrics?: Record<string, unknown>;
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

interface ExternalChatResponse {
  readonly model?: string;
  readonly choices?: Array<{
    readonly message?: {
      readonly content?: string;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly metrics?: Record<string, unknown>;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function buildArtifactFallbackAbstract(request: DeriveFromArtifactRequest): string {
  const basename = path.basename(request.artifactUri);
  switch (request.modality) {
    case "audio":
      return `Audio artifact ${basename} was ingested, but provider-backed transcription was unavailable at derivation time. The searchable proxy preserves the asset identity and provenance without claiming unseen spoken content.`;
    case "image":
      return `Image artifact ${basename} was ingested, but provider-backed visual extraction was unavailable at derivation time. The searchable proxy preserves the asset identity and provenance without claiming unseen OCR content.`;
    case "pdf":
      return `PDF artifact ${basename} was ingested, but provider-backed document extraction was unavailable at derivation time. The searchable proxy preserves the document identity and provenance without claiming unseen page text.`;
    case "video":
      return `Video artifact ${basename} was ingested, but provider-backed caption extraction was unavailable at derivation time. The searchable proxy preserves the asset identity and provenance without claiming unseen speech or scene details.`;
    default:
      return `Artifact ${basename} was ingested, but provider-backed derivation was unavailable at derivation time. The searchable proxy preserves the asset identity and provenance without inventing content.`;
  }
}

function shouldFallbackAudioDerivation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes("enoent") || message.includes("eacces") || message.includes("permission denied") || message.includes("no such file")) {
    return false;
  }

  return (
    message.includes("timed out") ||
    message.includes("runtime returned") ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  );
}

export function createExternalAdapter(): ProviderAdapter {
  const config = readConfig();

  return {
    id: "external",
    supports: {
      textEmbedding: true,
      multimodalDerivation: true,
      textClassification: true,
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
            input: request.text,
            text: request.text,
            dimensions: request.outputDimensionality ?? config.embeddingDimensions,
            output_dimensionality: request.outputDimensionality ?? config.embeddingDimensions,
            encoding_format: "float",
            metadata: request.metadata ?? {}
          }
        }
      );

      const embedding = result.data.embedding ?? result.data.data?.[0]?.embedding;
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
        tokenUsage: result.data.tokenUsage ?? {
          inputTokens: result.data.usage?.prompt_tokens,
          totalTokens: result.data.usage?.total_tokens
        },
        latencyMs: Date.now() - started,
        providerMetadata: {
          ...(result.data.providerMetadata ?? {}),
          metrics: result.data.metrics ?? {}
        }
      };
    },
    async deriveFromArtifact(request: DeriveFromArtifactRequest): Promise<DeriveFromArtifactResponse> {
      const started = Date.now();
      if (request.modality === "audio") {
        try {
          const transcript = await transcribeAudioFile({
            filePath: request.artifactUri,
            mimeType: request.mimeType,
            modelId: request.model && request.model !== config.externalAiDeriveModel ? request.model : undefined
          });

          return {
            provider: "external",
            model: transcript.model,
            modality: request.modality,
            contentAbstract: transcript.text,
            entities: [],
            provenance: {
              artifactUri: request.artifactUri
            },
            latencyMs: Date.now() - started,
            providerMetadata: {
              runtime_backend: "model_runtime_asr",
              language: transcript.language ?? null,
              duration_seconds: transcript.durationSeconds ?? null,
              segment_count: transcript.segments.length,
              word_count: transcript.words.length
            }
          };
        } catch (error) {
          if (!shouldFallbackAudioDerivation(error)) {
            throw error;
          }

          return {
            provider: "external",
            model: request.model ?? config.externalAiDeriveModel,
            modality: request.modality,
            contentAbstract: buildArtifactFallbackAbstract(request),
            confidenceScore: 0,
            entities: [path.basename(request.artifactUri)],
            provenance: {
              artifactUri: request.artifactUri
            },
            latencyMs: Date.now() - started,
            providerMetadata: {
              runtime_backend: "audio_identity_fallback",
              runtime_error: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
      const model = request.model ?? config.externalAiDeriveModel;
      try {
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
            timeoutMs: 300_000
          }
        );

        const contentAbstract = typeof result.data.contentAbstract === "string" ? result.data.contentAbstract.trim() : "";
        if (!contentAbstract) {
          throw new ProviderError({
            provider: "external",
            code: "PROVIDER_UNKNOWN",
            message: `External AI provider returned no derivation content for modality "${request.modality}".`
          });
        }

        return {
          provider: "external",
          model: result.data.model ?? model,
          modality: request.modality,
          contentAbstract,
          confidenceScore: result.data.confidenceScore,
          entities: result.data.entities ?? [],
          provenance: {
            artifactUri: result.data.provenance?.artifactUri ?? request.artifactUri,
            sourceChunkId: result.data.provenance?.sourceChunkId,
            byteOffsetStart: result.data.provenance?.byteOffsetStart,
            byteOffsetEnd: result.data.provenance?.byteOffsetEnd,
            pageNumber: result.data.provenance?.pageNumber,
            timestampMs: result.data.provenance?.timestampMs
          },
          latencyMs: Date.now() - started,
          providerMetadata: result.data.providerMetadata ?? {}
        };
      } catch (error) {
        if (!(error instanceof ProviderError) || ![404, 405].includes(error.statusCode ?? 0)) {
          throw error;
        }

        return {
          provider: "external",
          model,
          modality: request.modality,
          contentAbstract: buildArtifactFallbackAbstract(request),
          confidenceScore: 0,
          entities: [path.basename(request.artifactUri)],
          provenance: {
            artifactUri: request.artifactUri
          },
          latencyMs: Date.now() - started,
          providerMetadata: {
            runtime_backend: "filename_proxy_fallback",
            derive_endpoint_status: error.statusCode
          }
        };
      }
    },
    async classifyText(request: ClassifyTextRequest): Promise<ClassifyTextResponse> {
      const started = Date.now();
      const model = request.model ?? config.externalAiClassifyModel;
      const presetId = typeof request.metadata?.preset_id === "string"
        ? request.metadata.preset_id
        : config.externalAiClassifyPresetId;
      const enableThinking = request.metadata?.enable_thinking === true;
      const result = await postJson<ExternalChatResponse>(
        "external",
        `${config.externalAiBaseUrl}${config.externalAiClassifyPath}`,
        {
          headers: buildHeaders(config.externalAiApiKey),
          body: {
            model,
            preset_id: presetId,
            stream: false,
            response_format: "json",
            system_prompt: request.systemPrompt,
            enable_thinking: enableThinking,
            max_tokens: request.maxOutputTokens,
            messages: [
              {
                role: "user",
                content: request.instruction
                  ? `${request.instruction}\n\nTEXT TO CLASSIFY:\n${request.text}`
                  : request.text
              }
            ]
          },
          timeoutMs: 300_000
        }
      );

      const rawText = result.data.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        throw new ProviderError({
          provider: "external",
          code: "PROVIDER_UNKNOWN",
          message: "External AI provider returned no classification content"
        });
      }

      return {
        provider: "external",
        model: result.data.model ?? model,
        output: parseJsonObjectText("external", rawText),
        rawText,
        tokenUsage: {
          inputTokens: result.data.usage?.prompt_tokens,
          outputTokens: result.data.usage?.completion_tokens,
          totalTokens: result.data.usage?.total_tokens
        },
        latencyMs: Date.now() - started,
        providerMetadata: {
          preset_id: presetId,
          metrics: result.data.metrics ?? {}
        }
      };
    }
  };
}
