import { createHash } from "node:crypto";
import { readConfig } from "../config.js";

export type PublicBenchmarkMode = "sampled" | "full";

export interface BenchmarkVectorActivationMetadata {
  readonly scope: "runtime" | "benchmark";
  readonly mode: "off" | "queue_only" | "bounded" | "full";
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly namespacesActivated: number;
  readonly semanticEmbeddingCoverage: {
    readonly embedded: number;
    readonly total: number;
    readonly rate: number;
  };
  readonly derivationEmbeddingCoverage: {
    readonly embedded: number;
    readonly total: number;
    readonly rate: number;
  };
  readonly unavailableReason?: string;
}

export interface BenchmarkRuntimeMetadata {
  readonly benchmarkLane?: string;
  readonly benchmarkMode: PublicBenchmarkMode;
  readonly ieExtractorDefault: string | null;
  readonly gliner2ModelId: string | null;
  readonly gliner2SchemaVersion: string;
  readonly gliner2ShadowComparisonEnabled: boolean;
  readonly scorerMode: "fast_plus_normalized";
  readonly fastScorerVersion: string;
  readonly officialishScorerVersion: string;
  readonly retrievalFusionVersion: string;
  readonly projectionVersion: string;
  readonly fusedKernelMode: "shadow" | "preferred" | "required";
  readonly renderPayloadMode: "shadow" | "preferred" | "required";
  readonly rerankerEnabled: boolean;
  readonly rerankerVersion: string;
  readonly relationIeSchemaVersion: string;
  readonly relationIeExtractors: readonly string[];
  readonly relationIeThresholds: {
    readonly entity: number;
    readonly adjacency: number;
    readonly relation: number;
    readonly classification: number;
    readonly structure: number;
  };
  readonly lexicalProvider: "fts" | "bm25";
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly namespaceIsolation: "per_run_namespace";
  readonly iterativeScanMode: "off" | "relaxed_order" | "strict_order";
  readonly iterativeScanMaxScanTuples?: number;
  readonly vectorActivation?: BenchmarkVectorActivationMetadata;
  readonly sampleControls: Record<string, string | number | boolean | null>;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeRelationIeSchemaVersion(): string {
  const config = readConfig();
  const payload = {
    extractors: config.relationIeExtractors,
    entityLabels: config.relationIeEntityLabels,
    relationLabels: config.relationIeRelationLabels,
    entityDescriptions: config.relationIeEntityDescriptions,
    relationDescriptions: config.relationIeRelationDescriptions,
    thresholds: {
      entity: config.relationIeEntityThreshold,
      adjacency: config.relationIeAdjacencyThreshold,
      relation: config.relationIeRelationThreshold,
      classification: config.relationIeClassificationThreshold,
      structure: config.relationIeStructureThreshold
    }
  };
  const digest = createHash("sha256").update(stableSerialize(payload)).digest("hex").slice(0, 12);
  return `relation_ie_schema_${digest}`;
}

export function resolvePublicBenchmarkMode(requestedCount: number, totalCount: number): PublicBenchmarkMode {
  if (requestedCount >= totalCount) {
    return "full";
  }
  return "sampled";
}

export function resolveRequestedSampleCount(
  rawValue: string | undefined,
  fallback: number,
  totalCount: number
): number {
  if (!rawValue || !rawValue.trim()) {
    return Math.min(fallback, totalCount);
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "all" || normalized === "full") {
    return totalCount;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return totalCount;
  }
  return Math.min(totalCount, Math.max(1, Math.floor(parsed)));
}

export function buildBenchmarkRuntimeMetadata(input: {
  readonly benchmarkMode: PublicBenchmarkMode;
  readonly vectorActivation?: BenchmarkVectorActivationMetadata;
  readonly sampleControls: Record<string, string | number | boolean | null>;
}): BenchmarkRuntimeMetadata {
  const config = readConfig();
  return {
    benchmarkLane: process.env.BRAIN_BENCHMARK_LANE?.trim() || undefined,
    benchmarkMode: input.benchmarkMode,
    ieExtractorDefault: config.relationIeExtractors[0] ?? null,
    gliner2ModelId: config.relationIeGliner2Model ?? null,
    gliner2SchemaVersion: computeRelationIeSchemaVersion(),
    gliner2ShadowComparisonEnabled: config.relationIeExtractors.includes("gliner_relex"),
    scorerMode: "fast_plus_normalized",
    fastScorerVersion: config.benchmarkFastScorerVersion,
    officialishScorerVersion: config.benchmarkOfficialishScorerVersion,
    retrievalFusionVersion: config.retrievalFusionVersion,
    projectionVersion: "contract_projection_v2",
    fusedKernelMode: config.sqlFusedKernelMode,
    renderPayloadMode: config.renderPayloadMode,
    rerankerEnabled: config.localRerankerEnabled,
    rerankerVersion: config.localRerankerVersion,
    relationIeSchemaVersion: computeRelationIeSchemaVersion(),
    relationIeExtractors: config.relationIeExtractors,
    relationIeThresholds: {
      entity: config.relationIeEntityThreshold,
      adjacency: config.relationIeAdjacencyThreshold,
      relation: config.relationIeRelationThreshold,
      classification: config.relationIeClassificationThreshold,
      structure: config.relationIeStructureThreshold
    },
    lexicalProvider: config.lexicalProvider,
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    namespaceIsolation: "per_run_namespace",
    iterativeScanMode: config.pgvectorIterativeScanMode,
    iterativeScanMaxScanTuples: config.pgvectorMaxScanTuples,
    vectorActivation: input.vectorActivation,
    sampleControls: input.sampleControls
  };
}
