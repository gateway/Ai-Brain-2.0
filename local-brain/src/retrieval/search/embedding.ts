import { resolveEmbeddingRuntimeSelection } from "../../providers/embedding-config.js";
import { getProviderAdapter } from "../../providers/registry.js";
import { ProviderError } from "../../providers/types.js";
import type { RecallQuery } from "../types.js";

export async function resolveQueryEmbedding(
  query: RecallQuery
): Promise<{
  readonly embedding: number[] | null;
  readonly source: "provided" | "provider" | "none";
  readonly provider?: string;
  readonly model?: string;
  readonly fallbackReason?: string;
}> {
  if (query.queryEmbedding && query.queryEmbedding.length > 0) {
    return {
      embedding: [...query.queryEmbedding],
      source: "provided"
    };
  }

  const selection = resolveEmbeddingRuntimeSelection({
    provider: query.provider,
    model: query.model,
    outputDimensionality: query.outputDimensionality
  });

  if (!selection.enabled) {
    return {
      embedding: null,
      source: "none",
      fallbackReason: "provider:none"
    };
  }

  try {
    const adapter = getProviderAdapter(selection.provider);
    const response = await adapter.embedText({
      text: query.query,
      model: selection.model,
      outputDimensionality: selection.outputDimensionality
    });

    return {
      embedding: response.embedding,
      source: "provider",
      provider: response.provider,
      model: response.model
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        embedding: null,
        source: "none",
        fallbackReason: `${error.provider}:${error.code}`
      };
    }

    throw error;
  }
}
