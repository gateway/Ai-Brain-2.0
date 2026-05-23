import { performance } from "node:perf_hooks";
import { resolveEmbeddingRuntimeSelection } from "../../providers/embedding-config.js";
import { getProviderAdapter } from "../../providers/registry.js";
import { ProviderError } from "../../providers/types.js";
import type { RecallQuery } from "../types.js";
import { currentRuntimeRequestContext, memoizeRuntimeRequestPromise } from "./context.js";
import {
  buildQueryEmbeddingCacheIdentity,
  loadCachedQueryEmbedding,
  QUERY_EMBEDDING_NORMALIZATION_VERSION,
  runtimeQueryEmbeddingCacheKey,
  storeCachedQueryEmbedding
} from "./query-embedding-cache.js";

export async function resolveQueryEmbedding(
  query: RecallQuery
): Promise<{
  readonly embedding: number[] | null;
  readonly source: "provided" | "provider" | "none";
  readonly provider?: string;
  readonly model?: string;
  readonly fallbackReason?: string;
  readonly cacheHit?: boolean;
  readonly cacheLookupLatencyMs?: number;
  readonly providerLatencyMs?: number;
  readonly providerCallCount?: number;
  readonly normalizationVersion?: string;
}> {
  if (query.queryEmbedding && query.queryEmbedding.length > 0) {
    return {
      embedding: [...query.queryEmbedding],
      source: "provided",
      cacheHit: false,
      providerCallCount: 0
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
      fallbackReason: "provider:none",
      cacheHit: false,
      providerCallCount: 0
    };
  }
  if (!selection.model) {
    return {
      embedding: null,
      source: "none",
      fallbackReason: "provider:model_unresolved",
      cacheHit: false,
      providerCallCount: 0
    };
  }

  const identity = buildQueryEmbeddingCacheIdentity({
    queryText: query.query,
    provider: selection.provider,
    model: selection.model,
    outputDimensionality: selection.outputDimensionality
  });
  const runtimeContext = currentRuntimeRequestContext();
  const runtimeCacheKey = runtimeQueryEmbeddingCacheKey(identity);

  const resolve = async () => {
    const cacheLookupStartedAt = performance.now();
    const cached = await loadCachedQueryEmbedding(identity);
    const cacheLookupLatencyMs = Number((performance.now() - cacheLookupStartedAt).toFixed(2));
    if (cached) {
      return {
        embedding: [...cached.embedding],
        source: "provider" as const,
        provider: cached.provider,
        model: cached.model,
        cacheHit: true,
        cacheLookupLatencyMs,
        providerCallCount: 0,
        normalizationVersion: QUERY_EMBEDDING_NORMALIZATION_VERSION
      };
    }

    try {
      const adapter = getProviderAdapter(selection.provider);
      const response = await adapter.embedText({
        text: query.query,
        model: selection.model,
        outputDimensionality: selection.outputDimensionality
      });

      await storeCachedQueryEmbedding({
        identity,
        embedding: response.embedding,
        dimensions: response.dimensions,
        tokenUsage: response.tokenUsage ? { ...response.tokenUsage } : undefined,
        providerMetadata: response.providerMetadata ?? undefined,
        metadata: {
          query_length: query.query.length,
          cached_by: "resolveQueryEmbedding"
        }
      });

      return {
        embedding: response.embedding,
        source: "provider" as const,
        provider: response.provider,
        model: response.model,
        cacheHit: false,
        cacheLookupLatencyMs,
        providerLatencyMs: response.latencyMs,
        providerCallCount: 1,
        normalizationVersion: QUERY_EMBEDDING_NORMALIZATION_VERSION
      };
    } catch (error) {
      if (error instanceof ProviderError) {
        return {
          embedding: null,
          source: "none" as const,
          fallbackReason: `${error.provider}:${error.code}`,
          cacheHit: false,
          cacheLookupLatencyMs,
          providerCallCount: 1,
          normalizationVersion: QUERY_EMBEDDING_NORMALIZATION_VERSION
        };
      }

      throw error;
    }
  };

  if (!runtimeContext) {
    return resolve();
  }

  return memoizeRuntimeRequestPromise(runtimeContext.queryEmbeddingCache, runtimeCacheKey, resolve);
}
