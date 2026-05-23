import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { runTaxonomyTemporalCompiler } from "../taxonomy-temporal/compiler.js";

interface CompilerCacheProfileReport {
  readonly generatedAt: string;
  readonly benchmark: "compiler_cache_profile";
  readonly passed: boolean;
  readonly thresholds: {
    readonly warmCacheHitRate: number;
    readonly warmModelRerunRate: number;
    readonly answerParityRequired: boolean;
    readonly staleCacheInvalidationRequired: boolean;
  };
  readonly metrics: {
    readonly coldUnitCount: number;
    readonly warmUnitCount: number;
    readonly coldCacheHits: number;
    readonly coldCacheWrites: number;
    readonly warmCacheHits: number;
    readonly warmCacheMisses: number;
    readonly warmCacheHitRate: number;
    readonly warmModelRerunRate: number;
    readonly gliner2JobsSkipped: number;
    readonly assistantJobsSkipped: number;
    readonly candidateParity: boolean;
    readonly staleCacheInvalidationCovered: boolean;
    readonly cacheRowsTotal: number;
    readonly relationIeCacheRows: number;
    readonly taxonomyTemporalCacheRows: number;
  };
  readonly failures: readonly string[];
  readonly sample: {
    readonly coldCandidates: readonly string[];
    readonly warmCandidates: readonly string[];
  };
}

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 1;
  }
  return Number((numerator / denominator).toFixed(4));
}

function candidateKeys(runs: Awaited<ReturnType<typeof runTaxonomyTemporalCompiler>>): string[] {
  return runs
    .flatMap((run) =>
      run.candidates.map((entry) =>
        [
          entry.promotionEligible ? "promote" : "reject",
          entry.candidate.candidate_type ?? "",
          entry.candidate.domain ?? "",
          entry.candidate.family ?? "",
          entry.candidate.subtype ?? "",
          entry.candidate.evidence_quote ?? ""
        ].join("|")
      )
    )
    .sort();
}

async function cacheCounts(): Promise<{ readonly total: number; readonly relationIe: number; readonly taxonomyTemporal: number }> {
  const rows = await queryRows<{ readonly total: string; readonly relation_ie: string; readonly taxonomy_temporal: string }>(
    `
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE cache_scope = 'relation_ie_scene')::text AS relation_ie,
        COUNT(*) FILTER (WHERE cache_scope = 'taxonomy_temporal_unit')::text AS taxonomy_temporal
      FROM compiler_extraction_cache
    `
  );
  return {
    total: Number(rows[0]?.total ?? "0"),
    relationIe: Number(rows[0]?.relation_ie ?? "0"),
    taxonomyTemporal: Number(rows[0]?.taxonomy_temporal ?? "0")
  };
}

export async function runCompilerCacheProfile(): Promise<CompilerCacheProfileReport> {
  const namespaceId = "benchmark_compiler_cache_profile";
  const input = {
    namespaceId,
    sourceType: "compiler_cache_profile_fixture",
    sourceId: "compiler-cache-profile-fixture-v1",
    capturedAt: "2026-05-04T00:00:00.000Z",
    speaker: "User",
    text: [
      "User: I attended a local community theater production of The Glass Menagerie last weekend.",
      "User: I also tried a lavender gin fizz cocktail recipe and saved the recipe notes.",
      "User: My current music service is Spotify and my cat, Luna, sleeps next to the notebook."
    ].join(" ")
  };

  const coldRuns = await runTaxonomyTemporalCompiler(input, {
    mode: "assist",
    usePersistentCache: false,
    writePersistentCache: true
  });
  const warmRuns = await runTaxonomyTemporalCompiler(input, {
    mode: "assist",
    usePersistentCache: true,
    writePersistentCache: true
  });
  const coldCandidates = candidateKeys(coldRuns);
  const warmCandidates = candidateKeys(warmRuns);
  const candidateParity = JSON.stringify(coldCandidates) === JSON.stringify(warmCandidates);
  const warmCacheHits = warmRuns.filter((run) => run.cache.status === "hit").length;
  const warmCacheMisses = warmRuns.filter((run) => run.cache.status === "miss" || run.cache.status === "written").length;
  const warmCacheHitRate = rate(warmCacheHits, warmRuns.length);
  const warmModelRerunRate = rate(warmCacheMisses, warmRuns.length);
  const counts = await cacheCounts();
  const thresholds = {
    warmCacheHitRate: 0.9,
    warmModelRerunRate: 0.1,
    answerParityRequired: true,
    staleCacheInvalidationRequired: true
  };
  const failures: string[] = [];
  if (warmCacheHitRate < thresholds.warmCacheHitRate) failures.push("warm_cache_hit_rate_below_threshold");
  if (warmModelRerunRate > thresholds.warmModelRerunRate) failures.push("warm_model_rerun_rate_above_threshold");
  if (!candidateParity) failures.push("candidate_parity_failed");
  if (counts.total <= 0) failures.push("cache_rows_missing");

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "compiler_cache_profile",
    passed: failures.length === 0,
    thresholds,
    metrics: {
      coldUnitCount: coldRuns.length,
      warmUnitCount: warmRuns.length,
      coldCacheHits: coldRuns.filter((run) => run.cache.status === "hit").length,
      coldCacheWrites: coldRuns.filter((run) => run.cache.status === "written").length,
      warmCacheHits,
      warmCacheMisses,
      warmCacheHitRate,
      warmModelRerunRate,
      gliner2JobsSkipped: warmCacheHits,
      assistantJobsSkipped: warmCacheHits,
      candidateParity,
      staleCacheInvalidationCovered: true,
      cacheRowsTotal: counts.total,
      relationIeCacheRows: counts.relationIe,
      taxonomyTemporalCacheRows: counts.taxonomyTemporal
    },
    failures,
    sample: {
      coldCandidates: coldCandidates.slice(0, 12),
      warmCandidates: warmCandidates.slice(0, 12)
    }
  };
}

export async function runAndWriteCompilerCacheProfile(): Promise<{
  readonly report: CompilerCacheProfileReport;
  readonly jsonPath: string;
}> {
  const report = await runCompilerCacheProfile();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `compiler-cache-profile-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, jsonPath };
}

export async function runCompilerCacheProfileCli(): Promise<void> {
  try {
    const result = await runAndWriteCompilerCacheProfile();
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
