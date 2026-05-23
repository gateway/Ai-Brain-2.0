import type { RunNamespaceVectorActivationResult } from "../jobs/vector-sync-runtime.js";
import type { BenchmarkVectorActivationMetadata } from "./runtime-metadata.js";

export interface BenchmarkVectorActivationAccumulator {
  readonly scope: "runtime" | "benchmark";
  readonly mode: "off" | "queue_only" | "bounded" | "full";
  readonly provider: string;
  readonly model: string;
  readonly outputDimensionality?: number;
  readonly namespacesActivated: number;
  readonly semanticEmbedded: number;
  readonly semanticTotal: number;
  readonly derivationEmbedded: number;
  readonly derivationTotal: number;
  readonly unavailableReasons: readonly string[];
}

export function createBenchmarkVectorActivationAccumulator(
  scope: "runtime" | "benchmark",
  mode: "off" | "queue_only" | "bounded" | "full",
  provider: string,
  model: string,
  outputDimensionality?: number
): BenchmarkVectorActivationAccumulator {
  return {
    scope,
    mode,
    provider,
    model,
    outputDimensionality,
    namespacesActivated: 0,
    semanticEmbedded: 0,
    semanticTotal: 0,
    derivationEmbedded: 0,
    derivationTotal: 0,
    unavailableReasons: []
  };
}

export function mergeBenchmarkVectorActivation(
  accumulator: BenchmarkVectorActivationAccumulator,
  activation: RunNamespaceVectorActivationResult
): BenchmarkVectorActivationAccumulator {
  return {
    scope: activation.scope,
    mode: activation.mode,
    provider: activation.provider || accumulator.provider,
    model: activation.model || accumulator.model,
    outputDimensionality: activation.outputDimensionality ?? accumulator.outputDimensionality,
    namespacesActivated: accumulator.namespacesActivated + 1,
    semanticEmbedded: accumulator.semanticEmbedded + activation.coverage.semanticEmbedded,
    semanticTotal: accumulator.semanticTotal + activation.coverage.semanticTotal,
    derivationEmbedded: accumulator.derivationEmbedded + activation.coverage.derivationEmbedded,
    derivationTotal: accumulator.derivationTotal + activation.coverage.derivationTotal,
    unavailableReasons:
      activation.unavailableReason && activation.unavailableReason.trim().length > 0
        ? [...accumulator.unavailableReasons, activation.unavailableReason]
        : accumulator.unavailableReasons
  };
}

function rate(embedded: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number((embedded / total).toFixed(4));
}

export function buildBenchmarkVectorActivationMetadata(
  accumulator: BenchmarkVectorActivationAccumulator
): BenchmarkVectorActivationMetadata {
  return {
    scope: accumulator.scope,
    mode: accumulator.mode,
    provider: accumulator.provider,
    model: accumulator.model,
    outputDimensionality: accumulator.outputDimensionality,
    namespacesActivated: accumulator.namespacesActivated,
    semanticEmbeddingCoverage: {
      embedded: accumulator.semanticEmbedded,
      total: accumulator.semanticTotal,
      rate: rate(accumulator.semanticEmbedded, accumulator.semanticTotal)
    },
    derivationEmbeddingCoverage: {
      embedded: accumulator.derivationEmbedded,
      total: accumulator.derivationTotal,
      rate: rate(accumulator.derivationEmbedded, accumulator.derivationTotal)
    },
    unavailableReason:
      accumulator.unavailableReasons.length > 0
        ? [...new Set(accumulator.unavailableReasons)].join(" | ")
        : undefined
  };
}
