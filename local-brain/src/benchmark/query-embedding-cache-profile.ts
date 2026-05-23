import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { closePool } from "../db/client.js";
import { readConfig } from "../config.js";
import { runMigrations } from "../db/migrations.js";
import { resolveQueryEmbedding } from "../retrieval/search/embedding.js";
import { benchmarkOutputDir, percentile, rate } from "./query-benchmark-utils.js";

interface QueryEmbeddingCacheProfileRow {
  readonly query: string;
  readonly coldLatencyMs: number;
  readonly coldProviderLatencyMs: number;
  readonly coldCacheHit: boolean;
  readonly coldProviderCallCount: number;
  readonly warmPrimeLatencyMs: number;
  readonly warmLatencyMs: number;
  readonly warmCacheHit: boolean;
  readonly warmProviderCallCount: number;
  readonly dimensions: number;
}

export interface QueryEmbeddingCacheProfileReport {
  readonly generatedAt: string;
  readonly benchmark: "query_embedding_cache_profile";
  readonly passed: boolean;
  readonly provider: string;
  readonly model: string;
  readonly metrics: {
    readonly totalQueries: number;
    readonly coldProviderP95LatencyMs: number;
    readonly warmP95LatencyMs: number;
    readonly warmCacheHitRate: number;
    readonly warmProviderCallCount: number;
    readonly coldProviderCallCount: number;
  };
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly rows: readonly QueryEmbeddingCacheProfileRow[];
}

function buildQueries(runId: string): readonly string[] {
  return [
    `cache-profile ${runId} what is ai brain`,
    `cache-profile ${runId} how do i run production readiness`,
    `cache-profile ${runId} what coffee do i prefer now`,
    `cache-profile ${runId} why does the brain think steve prefers pour-over coffee now`,
    `cache-profile ${runId} who are steves friends`,
    `cache-profile ${runId} what happened between lauren and me`
  ];
}

async function resolveOnce(queryText: string): Promise<{
  readonly latencyMs: number;
  readonly providerLatencyMs: number;
  readonly cacheHit: boolean;
  readonly providerCallCount: number;
  readonly dimensions: number;
}> {
  const startedAt = performance.now();
  const result = await resolveQueryEmbedding({
    namespaceId: "personal",
    query: queryText
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  return {
    latencyMs,
    providerLatencyMs: typeof result.providerLatencyMs === "number" ? result.providerLatencyMs : latencyMs,
    cacheHit: result.cacheHit === true,
    providerCallCount: typeof result.providerCallCount === "number" ? result.providerCallCount : 0,
    dimensions: Array.isArray(result.embedding) ? result.embedding.length : 0
  };
}

export async function runQueryEmbeddingCacheProfileBenchmark(): Promise<QueryEmbeddingCacheProfileReport> {
  await runMigrations();
  const config = readConfig();
  const runId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const queries = buildQueries(runId);
  const rows: QueryEmbeddingCacheProfileRow[] = [];
  for (const query of queries) {
    const cold = await resolveOnce(query);
    const warmPrime = await resolveOnce(query);
    const warm = await resolveOnce(query);
    rows.push({
      query,
      coldLatencyMs: cold.latencyMs,
      coldProviderLatencyMs: cold.providerLatencyMs,
      coldCacheHit: cold.cacheHit,
      coldProviderCallCount: cold.providerCallCount,
      warmPrimeLatencyMs: warmPrime.latencyMs,
      warmLatencyMs: warm.latencyMs,
      warmCacheHit: warm.cacheHit,
      warmProviderCallCount: warm.providerCallCount,
      dimensions: warm.dimensions || cold.dimensions
    });
  }

  const metrics = {
    totalQueries: rows.length,
    coldProviderP95LatencyMs: percentile(rows.map((row) => row.coldProviderLatencyMs), 95),
    warmP95LatencyMs: percentile(rows.map((row) => row.warmLatencyMs), 95),
    warmCacheHitRate: rate(rows.filter((row) => row.warmCacheHit).length, rows.length),
    warmProviderCallCount: rows.reduce((sum, row) => sum + row.warmProviderCallCount, 0),
    coldProviderCallCount: rows.reduce((sum, row) => sum + row.coldProviderCallCount, 0)
  };
  const failures: string[] = [];
  const warnings: string[] = [];
  if (metrics.warmCacheHitRate < 0.95) failures.push("warm_cache_hit_rate_below_gate");
  if (metrics.warmProviderCallCount > 0) failures.push("warm_provider_calls_nonzero");
  if (metrics.warmP95LatencyMs > 25) failures.push("warm_query_embedding_lookup_latency_above_gate");
  if (rows.some((row) => row.dimensions <= 0)) failures.push("empty_embedding_vector_detected");
  if (metrics.coldProviderP95LatencyMs > 250) warnings.push("cold_query_embedding_provider_latency_above_target");

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "query_embedding_cache_profile",
    passed: failures.length === 0,
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    metrics,
    failures,
    warnings,
    rows
  };
}

export async function runAndWriteQueryEmbeddingCacheProfileBenchmark(): Promise<QueryEmbeddingCacheProfileReport> {
  const report = await runQueryEmbeddingCacheProfileBenchmark();
  const dir = benchmarkOutputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `query-embedding-cache-profile-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(dir, `query-embedding-cache-profile-${stamp}.md`),
    [
      "# Query Embedding Cache Profile",
      "",
      `- passed: ${report.passed}`,
      `- provider: ${report.provider}`,
      `- model: ${report.model}`,
      `- warmCacheHitRate: ${report.metrics.warmCacheHitRate}`,
      `- coldProviderP95LatencyMs: ${report.metrics.coldProviderP95LatencyMs}`,
      `- warmP95LatencyMs: ${report.metrics.warmP95LatencyMs}`,
      `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`,
      `- warnings: ${report.warnings.length === 0 ? "none" : report.warnings.join(", ")}`
    ].join("\n") + "\n"
  );
  await closePool();
  if (!report.passed) {
    throw new Error(`query-embedding-cache-profile failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runQueryEmbeddingCacheProfileCli(): Promise<void> {
  const report = await runAndWriteQueryEmbeddingCacheProfileBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
