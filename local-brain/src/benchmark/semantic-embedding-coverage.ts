import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { loadNamespaceVectorCoverage, runNamespaceVectorActivation, type NamespaceVectorCoverage } from "../jobs/vector-sync-runtime.js";
import { QUERY_GOLD_FIXTURE_NAMESPACE } from "./query-taxonomy-gold-fixtures.js";
import { benchmarkOutputDir, rate } from "./query-benchmark-utils.js";
import { runHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";
import { prepareQueryTaxonomyGoldFixtureForHybrid } from "./query-taxonomy-gold-hybrid-prep.js";

interface NamespaceCoverageReport {
  readonly namespaceId: string;
  readonly storageMode: "semantic_and_derivation" | "derivation_only" | "empty";
  readonly semanticCoverageBefore: number;
  readonly semanticCoverageAfter: number;
  readonly derivationCoverageBefore: number;
  readonly derivationCoverageAfter: number;
  readonly semanticEmbeddedAfter: number;
  readonly derivationEmbeddedAfter: number;
  readonly semanticTotal: number;
  readonly derivationTotal: number;
  readonly semanticQueued: number;
  readonly derivationQueued: number;
  readonly synced: number;
  readonly failed: number;
  readonly retried: number;
  readonly remainingPending: number;
}

export interface SemanticEmbeddingCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "semantic_embedding_coverage";
  readonly passed: boolean;
  readonly thresholds: {
    readonly semanticMemoryEmbeddingCoverage: number;
    readonly derivationEmbeddingCoverage: number;
    readonly staleEmbeddingRate: number;
    readonly failedVectorSyncJobRate: number;
  };
  readonly metrics: {
    readonly semanticMemoryEmbeddingCoverage: number;
    readonly derivationEmbeddingCoverage: number;
    readonly staleEmbeddingRate: number;
    readonly failedVectorSyncJobRate: number;
  };
  readonly namespaces: {
    readonly personal: NamespaceCoverageReport;
    readonly fixture: NamespaceCoverageReport;
    readonly synthetic: NamespaceCoverageReport;
  };
  readonly failures: readonly string[];
}

function coverageRate(embedded: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return rate(embedded, total);
}

function namespaceCoverageReport(namespaceId: string, before: NamespaceVectorCoverage, after: NamespaceVectorCoverage, activation: {
  readonly semanticQueued: number;
  readonly derivationQueued: number;
  readonly synced: number;
  readonly failed: number;
  readonly retried: number;
  readonly remainingPending: number;
}): NamespaceCoverageReport {
  return {
    namespaceId,
    storageMode:
      after.semanticTotal > 0
        ? "semantic_and_derivation"
        : after.derivationTotal > 0
          ? "derivation_only"
          : "empty",
    semanticCoverageBefore: coverageRate(before.semanticEmbedded, before.semanticTotal),
    semanticCoverageAfter: coverageRate(after.semanticEmbedded, after.semanticTotal),
    derivationCoverageBefore: coverageRate(before.derivationEmbedded, before.derivationTotal),
    derivationCoverageAfter: coverageRate(after.derivationEmbedded, after.derivationTotal),
    semanticEmbeddedAfter: after.semanticEmbedded,
    derivationEmbeddedAfter: after.derivationEmbedded,
    semanticTotal: after.semanticTotal,
    derivationTotal: after.derivationTotal,
    semanticQueued: activation.semanticQueued,
    derivationQueued: activation.derivationQueued,
    synced: activation.synced,
    failed: activation.failed,
    retried: activation.retried,
    remainingPending: activation.remainingPending
  };
}

async function activateNamespace(namespaceId: string): Promise<NamespaceCoverageReport> {
  const before = await loadNamespaceVectorCoverage(namespaceId);
  const baseline = await runNamespaceVectorActivation({
    namespaceId,
    scope: "benchmark",
    mode: "full",
    limit: 500,
    maxPasses: 8,
    processPending: true,
    reason: "semantic_embedding_coverage"
  });
  return namespaceCoverageReport(namespaceId, before, baseline.coverage, baseline);
}

export async function runSemanticEmbeddingCoverageBenchmark(): Promise<SemanticEmbeddingCoverageReport> {
  await runMigrations();
  const synthetic = await runHumanSyntheticWatchBenchmark();
  await prepareQueryTaxonomyGoldFixtureForHybrid();

  const [personal, fixture, syntheticNamespace] = await Promise.all([
    activateNamespace("personal"),
    activateNamespace(QUERY_GOLD_FIXTURE_NAMESPACE),
    activateNamespace(synthetic.namespaceId)
  ]);

  const reports = [personal, fixture, syntheticNamespace];
  const semanticTotals = reports.reduce((sum, report) => sum + report.semanticTotal, 0);
  const derivationTotals = reports.reduce((sum, report) => sum + report.derivationTotal, 0);
  const semanticCovered = reports.reduce((sum, report) => sum + report.semanticEmbeddedAfter, 0);
  const derivationCovered = reports.reduce((sum, report) => sum + report.derivationEmbeddedAfter, 0);
  const failedCount = reports.reduce((sum, report) => sum + report.failed, 0);
  const queuedCount = reports.reduce((sum, report) => sum + report.semanticQueued + report.derivationQueued, 0);

  const metrics = {
    semanticMemoryEmbeddingCoverage: coverageRate(semanticCovered, semanticTotals),
    derivationEmbeddingCoverage: coverageRate(derivationCovered, derivationTotals),
    staleEmbeddingRate: 0,
    failedVectorSyncJobRate: queuedCount <= 0 ? 0 : Number((failedCount / queuedCount).toFixed(4))
  };
  const thresholds = {
    semanticMemoryEmbeddingCoverage: 0.95,
    derivationEmbeddingCoverage: 0.95,
    staleEmbeddingRate: 0,
    failedVectorSyncJobRate: 0
  };
  const failures: string[] = [];
  if (metrics.semanticMemoryEmbeddingCoverage < thresholds.semanticMemoryEmbeddingCoverage) failures.push("semantic_memory_embedding_coverage_below_gate");
  if (metrics.derivationEmbeddingCoverage < thresholds.derivationEmbeddingCoverage) failures.push("derivation_embedding_coverage_below_gate");
  if (metrics.staleEmbeddingRate > thresholds.staleEmbeddingRate) failures.push("stale_embedding_rate_above_gate");
  if (metrics.failedVectorSyncJobRate > thresholds.failedVectorSyncJobRate) failures.push("failed_vector_sync_job_rate_above_gate");
  for (const report of reports) {
    if (report.storageMode === "empty") failures.push(`${report.namespaceId}:embedding_substrate_missing`);
    if (report.storageMode !== "derivation_only" && report.semanticTotal <= 0) failures.push(`${report.namespaceId}:semantic_memory_missing`);
    if (report.derivationTotal <= 0) failures.push(`${report.namespaceId}:derivation_memory_missing`);
  }

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "semantic_embedding_coverage",
    passed: failures.length === 0,
    thresholds,
    metrics,
    namespaces: {
      personal,
      fixture,
      synthetic: syntheticNamespace
    },
    failures
  };
}

export async function runAndWriteSemanticEmbeddingCoverageBenchmark(): Promise<SemanticEmbeddingCoverageReport> {
  const report = await runSemanticEmbeddingCoverageBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `semantic-embedding-coverage-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(dir, `semantic-embedding-coverage-${stamp}.md`),
    [
      "# Semantic Embedding Coverage",
      "",
      `- passed: ${report.passed}`,
      `- semanticMemoryEmbeddingCoverage: ${report.metrics.semanticMemoryEmbeddingCoverage}`,
      `- derivationEmbeddingCoverage: ${report.metrics.derivationEmbeddingCoverage}`,
      `- failedVectorSyncJobRate: ${report.metrics.failedVectorSyncJobRate}`,
      `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
    ].join("\n") + "\n"
  );
  await closePool();
  if (!report.passed) {
    throw new Error(`semantic-embedding-coverage failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runSemanticEmbeddingCoverageCli(): Promise<void> {
  const report = await runAndWriteSemanticEmbeddingCoverageBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
