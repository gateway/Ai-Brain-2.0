import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";

type JsonRecord = Record<string, any>;

interface ArtifactRef<T extends JsonRecord = JsonRecord> {
  readonly path: string;
  readonly report: T;
}

interface ProductionReadinessReport {
  readonly generatedAt: string;
  readonly benchmark: "production_readiness";
  readonly artifactSchemaVersion: "production_readiness_v2";
  readonly passed: boolean;
  readonly artifactMode: "manifest" | "latest";
  readonly latestArtifactMode: boolean;
  readonly manifestPath: string | null;
  readonly thresholds: {
    readonly longmemPassRate: number;
    readonly longmemP95Ms: number;
    readonly longmemMaxMsHard: number;
    readonly longmemMaxMsTarget: number;
    readonly longmemManifestHitRate: number;
    readonly longmemSessionManifestHitRate: number;
    readonly longmemWarmSnapshotHitRate: number;
    readonly omiWatchP95Ms: number;
    readonly omiWatchMaxMs: number;
    readonly temporalMiniPass: string;
    readonly compilerWarmHitRate: number;
    readonly compilerWarmModelRerunRate: number;
  };
  readonly artifacts: Record<string, string | null>;
  readonly productionReadiness: {
    readonly correctness: {
      readonly longmem50PassRate: number;
      readonly personalOmiPassWarningFail: string;
      readonly omiWatchPassRate: string;
      readonly omiShadowNoisyStructureCount: number;
      readonly omiShadowPromotedRowCount: number;
      readonly temporalMiniPassRate: string;
      readonly locomoMiniScore?: number;
    };
    readonly latency: {
      readonly longmemP50Ms: number;
      readonly longmemP95Ms: number;
      readonly longmemMaxMs: number;
      readonly omiWatchP50Ms: number;
      readonly omiWatchP95Ms: number;
      readonly omiWatchMaxMs: number;
      readonly personalOmiP95Ms: number;
    };
    readonly cache: {
      readonly manifestHitRate: number;
      readonly sessionManifestHitRate: number;
      readonly warmSnapshotHitRate: number;
      readonly coldRebuildCount: number;
      readonly staleCacheMismatchCount: number;
      readonly staleManifestMismatchCount: number;
      readonly answerParityMismatchCount: number;
      readonly sessionsSkipped: number;
      readonly sessionsIngested: number;
      readonly compilerWarmCacheHitRate: number;
      readonly compilerWarmModelRerunRate: number;
      readonly gliner2JobsSkipped: number;
      readonly assistantJobsSkipped: number;
    };
    readonly routePurity: {
      readonly fallbackDerivedSuccessCount: number;
      readonly broadFallbackAfterSufficientTypedSupportCount: number;
      readonly directRouteSuccessCountByFamily: Record<string, number>;
    };
  };
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
}

interface ProductionReadinessManifest {
  readonly artifacts: {
    readonly longmem: string;
    readonly omiWatch: string;
    readonly omiShadow: string;
    readonly personalOmi: string;
    readonly temporalMini: string;
    readonly compilerCache: string;
    readonly locomo?: string | null;
    readonly relationshipMapProjection?: string | null;
    readonly humanQueryContractRouting?: string | null;
    readonly ingestionRoutingCoverage?: string | null;
    readonly ingestionDbCoverage?: string | null;
    readonly ingestionTortureCorpus?: string | null;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

async function latestArtifact<T extends JsonRecord>(
  matcher: (fileName: string) => boolean,
  required: boolean
): Promise<ArtifactRef<T> | null> {
  const files = (await readdir(outputDir())).filter((file) => matcher(file)).sort();
  const latest = files.at(-1);
  if (!latest) {
    if (required) {
      throw new Error("Required benchmark artifact is missing");
    }
    return null;
  }
  const artifactPath = path.join(outputDir(), latest);
  return {
    path: artifactPath,
    report: JSON.parse(await readFile(artifactPath, "utf8")) as T
  };
}

async function artifactFromPath<T extends JsonRecord>(artifactPath: string): Promise<ArtifactRef<T>> {
  const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(localBrainRoot(), "..", artifactPath);
  return {
    path: resolved,
    report: JSON.parse(await readFile(resolved, "utf8")) as T
  };
}

async function readManifest(manifestPath: string): Promise<{
  readonly manifestPath: string;
  readonly manifest: ProductionReadinessManifest;
}> {
  const resolved = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(localBrainRoot(), "..", manifestPath);
  return {
    manifestPath: resolved,
    manifest: JSON.parse(await readFile(resolved, "utf8")) as ProductionReadinessManifest
  };
}

function ratioText(pass: number, warning: number, fail: number): string {
  return `${pass}/${warning}/${fail}`;
}

function extractorSummary(report: JsonRecord, extractor: string): JsonRecord | null {
  const summaries = Array.isArray(report.extractorSummaries) ? report.extractorSummaries : [];
  return summaries.find((entry: JsonRecord) => entry?.extractor === extractor) ?? null;
}

function locomoScore(report: JsonRecord | null): number | undefined {
  if (!report) {
    return undefined;
  }
  if (typeof report.passRate === "number") {
    return report.passRate;
  }
  if (typeof report.score === "number") {
    return report.score;
  }
  if (typeof report.normalizedPassRate === "number") {
    return report.normalizedPassRate;
  }
  return undefined;
}

function toMarkdown(report: ProductionReadinessReport): string {
  const lines = [
    "# Production Readiness Gate",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- artifactMode: ${report.artifactMode}`,
    `- latestArtifactMode: ${report.latestArtifactMode}`,
    `- manifestPath: ${report.manifestPath ?? "-"}`,
    "",
    "## Correctness",
    "",
    `- LongMem 50 passRate: ${report.productionReadiness.correctness.longmem50PassRate}`,
    `- Personal OMI: ${report.productionReadiness.correctness.personalOmiPassWarningFail}`,
    `- OMI watch: ${report.productionReadiness.correctness.omiWatchPassRate}`,
    `- OMI shadow noise/promoted: ${report.productionReadiness.correctness.omiShadowNoisyStructureCount}/${report.productionReadiness.correctness.omiShadowPromotedRowCount}`,
    `- Temporal mini: ${report.productionReadiness.correctness.temporalMiniPassRate}`,
    "",
    "## Latency",
    "",
    `- LongMem p50/p95/max: ${report.productionReadiness.latency.longmemP50Ms}/${report.productionReadiness.latency.longmemP95Ms}/${report.productionReadiness.latency.longmemMaxMs}ms`,
    `- OMI watch p50/p95/max: ${report.productionReadiness.latency.omiWatchP50Ms}/${report.productionReadiness.latency.omiWatchP95Ms}/${report.productionReadiness.latency.omiWatchMaxMs}ms`,
    `- Personal OMI p95: ${report.productionReadiness.latency.personalOmiP95Ms}ms`,
    "",
    "## Cache",
    "",
    `- manifestHitRate: ${report.productionReadiness.cache.manifestHitRate}`,
    `- sessionManifestHitRate: ${report.productionReadiness.cache.sessionManifestHitRate}`,
    `- warmSnapshotHitRate: ${report.productionReadiness.cache.warmSnapshotHitRate}`,
    `- sessions skipped/ingested: ${report.productionReadiness.cache.sessionsSkipped}/${report.productionReadiness.cache.sessionsIngested}`,
    `- coldRebuildCount: ${report.productionReadiness.cache.coldRebuildCount}`,
    `- staleManifestMismatchCount: ${report.productionReadiness.cache.staleManifestMismatchCount}`,
    `- answerParityMismatchCount: ${report.productionReadiness.cache.answerParityMismatchCount}`,
    "",
    "## Failures",
    "",
    ...report.failures.map((failure) => `- ${failure}`),
    "",
    "## Warnings",
    "",
    ...report.warnings.map((warning) => `- ${warning}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteProductionReadinessBenchmark(options: { readonly manifestPath?: string | null } = {}): Promise<{
  readonly report: ProductionReadinessReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const manifestEnvelope = options.manifestPath ? await readManifest(options.manifestPath) : null;
  const artifactMode = manifestEnvelope ? "manifest" : "latest";
  const latestArtifactMode = artifactMode === "latest";
  const longmem = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.longmem)
    : await latestArtifact<JsonRecord>(
      (file) => /^longmemeval-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file) && !file.includes(".partial"),
      true
    );
  const omiWatch = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.omiWatch)
    : await latestArtifact<JsonRecord>((file) => file.startsWith("omi-watch-smoke-") && file.endsWith(".json"), true);
  const omiShadow = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.omiShadow)
    : await latestArtifact<JsonRecord>((file) => file.startsWith("omi-extraction-shadow-") && file.endsWith(".json"), true);
  const personalOmi = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.personalOmi)
    : await latestArtifact<JsonRecord>((file) => file.startsWith("personal-omi-review-") && file.endsWith(".json"), true);
  const temporalMini = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.temporalMini)
    : await latestArtifact<JsonRecord>((file) => file.startsWith("temporal-semantic-mini-") && file.endsWith(".json"), true);
  const compilerCache = manifestEnvelope
    ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.compilerCache)
    : await latestArtifact<JsonRecord>((file) => file.startsWith("compiler-cache-profile-") && file.endsWith(".json"), true);
  const locomo = manifestEnvelope
    ? manifestEnvelope.manifest.artifacts.locomo
      ? await artifactFromPath<JsonRecord>(manifestEnvelope.manifest.artifacts.locomo)
      : null
    : await latestArtifact<JsonRecord>(
      (file) => /^locomo-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file) && !file.includes(".partial"),
      false
    );

  const longmemCache = longmem!.report.productionReadiness?.cache ?? {};
  const longmemLatency = longmem!.report.productionReadiness?.latency ?? longmem!.report.latency ?? {};
  const longmemRoutePurity = longmem!.report.productionReadiness?.routePurity ?? {};
  const omiWatchLatency = omiWatch!.report.productionReadiness?.latency ?? {};
  const omiWatchCorrectness = omiWatch!.report.productionReadiness?.correctness ?? {};
  const gliner2 = extractorSummary(omiShadow!.report, "gliner2") ?? {};
  const personalSummary = personalOmi!.report.summary ?? {};
  const temporalSummary = temporalMini!.report.summary ?? {};
  const compilerMetrics = compilerCache!.report.metrics ?? {};
  const thresholds = {
    longmemPassRate: 1,
    longmemP95Ms: 250,
    longmemMaxMsHard: 6000,
    longmemMaxMsTarget: 5000,
    longmemManifestHitRate: 0.98,
    longmemSessionManifestHitRate: 0.98,
    longmemWarmSnapshotHitRate: 1,
    omiWatchP95Ms: 10000,
    omiWatchMaxMs: 20000,
    temporalMiniPass: "40/40",
    compilerWarmHitRate: 1,
    compilerWarmModelRerunRate: 0
  };
  const productionReadiness: ProductionReadinessReport["productionReadiness"] = {
    correctness: {
      longmem50PassRate: Number(longmem!.report.productionReadiness?.correctness?.longmem50PassRate ?? longmem!.report.passRate ?? 0),
      personalOmiPassWarningFail: ratioText(
        Number(personalSummary.pass ?? 0),
        Number(personalSummary.warning ?? 0),
        Number(personalSummary.fail ?? 0)
      ),
      omiWatchPassRate: String(omiWatchCorrectness.omiWatchPassRate ?? "0/0"),
      omiShadowNoisyStructureCount: Number(gliner2.noisyStructureCount ?? 0),
      omiShadowPromotedRowCount: Number(gliner2.promotedRowCount ?? 0),
      temporalMiniPassRate: `${Number(temporalSummary.pass ?? 0)}/${Number(temporalSummary.total ?? 0)}`,
      ...(locomo ? { locomoMiniScore: locomoScore(locomo.report) } : {})
    },
    latency: {
      longmemP50Ms: Number(longmemLatency.longmemP50Ms ?? longmem!.report.latency?.p50Ms ?? 0),
      longmemP95Ms: Number(longmemLatency.longmemP95Ms ?? longmem!.report.latency?.p95Ms ?? 0),
      longmemMaxMs: Number(longmemLatency.longmemMaxMs ?? longmem!.report.latency?.maxMs ?? 0),
      omiWatchP50Ms: Number(omiWatchLatency.omiWatchP50Ms ?? 0),
      omiWatchP95Ms: Number(omiWatchLatency.omiWatchP95Ms ?? 0),
      omiWatchMaxMs: Number(omiWatchLatency.omiWatchMaxMs ?? 0),
      personalOmiP95Ms: Number(personalOmi!.report.latency?.p95Ms ?? 0)
    },
    cache: {
      manifestHitRate: Number(longmemCache.manifestHitRate ?? 0),
      sessionManifestHitRate: Number(longmemCache.sessionManifestHitRate ?? longmemCache.manifestHitRate ?? 0),
      warmSnapshotHitRate: Number(longmemCache.warmSnapshotHitRate ?? 0),
      coldRebuildCount: Number(longmemCache.coldRebuildCount ?? 0),
      staleCacheMismatchCount: Number(longmemCache.staleCacheMismatchCount ?? 0),
      staleManifestMismatchCount: Number(longmemCache.staleManifestMismatchCount ?? longmemCache.staleCacheMismatchCount ?? 0),
      answerParityMismatchCount: Number(longmemCache.answerParityMismatchCount ?? 0),
      sessionsSkipped: Number(longmemCache.sessionsSkipped ?? 0),
      sessionsIngested: Number(longmemCache.sessionsIngested ?? 0),
      compilerWarmCacheHitRate: Number(compilerMetrics.warmCacheHitRate ?? 0),
      compilerWarmModelRerunRate: Number(compilerMetrics.warmModelRerunRate ?? 1),
      gliner2JobsSkipped: Number(longmemCache.gliner2JobsSkipped ?? 0),
      assistantJobsSkipped: Number(longmemCache.assistantJobsSkipped ?? 0)
    },
    routePurity: {
      fallbackDerivedSuccessCount: Number(longmemRoutePurity.fallbackDerivedSuccessCount ?? 0),
      broadFallbackAfterSufficientTypedSupportCount: Number(longmemRoutePurity.broadFallbackAfterSufficientTypedSupportCount ?? 0),
      directRouteSuccessCountByFamily: longmemRoutePurity.directRouteSuccessCountByFamily ?? {}
    }
  };

  const failures: string[] = [];
  const warnings: string[] = [];
  if (productionReadiness.correctness.longmem50PassRate < thresholds.longmemPassRate) failures.push("longmem_50_not_perfect");
  if (productionReadiness.latency.longmemP95Ms > thresholds.longmemP95Ms) failures.push("longmem_p95_above_gate");
  if (productionReadiness.latency.longmemMaxMs > thresholds.longmemMaxMsHard) failures.push("longmem_max_above_hard_gate");
  if (productionReadiness.latency.longmemMaxMs > thresholds.longmemMaxMsTarget) warnings.push("longmem_max_above_target_but_within_hard_gate");
  if (productionReadiness.cache.manifestHitRate < thresholds.longmemManifestHitRate) failures.push("longmem_manifest_hit_rate_below_gate");
  if (productionReadiness.cache.sessionManifestHitRate < thresholds.longmemSessionManifestHitRate) failures.push("longmem_session_manifest_hit_rate_below_gate");
  if (productionReadiness.cache.warmSnapshotHitRate < thresholds.longmemWarmSnapshotHitRate) failures.push("longmem_warm_snapshot_hit_rate_below_gate");
  if (productionReadiness.cache.coldRebuildCount > 0) failures.push("longmem_cold_rebuilds_on_warm_run");
  if (productionReadiness.cache.staleManifestMismatchCount > 0) failures.push("stale_manifest_mismatch");
  if (productionReadiness.cache.answerParityMismatchCount > 0) failures.push("answer_parity_mismatch");
  if (productionReadiness.correctness.personalOmiPassWarningFail !== "29/0/0") failures.push("personal_omi_regressed");
  if (productionReadiness.correctness.omiWatchPassRate !== "9/9") failures.push("omi_watch_regressed");
  if (productionReadiness.latency.omiWatchP95Ms > thresholds.omiWatchP95Ms) failures.push("omi_watch_p95_above_gate");
  if (productionReadiness.latency.omiWatchMaxMs > thresholds.omiWatchMaxMs) failures.push("omi_watch_max_above_gate");
  if (productionReadiness.correctness.omiShadowNoisyStructureCount !== 0) failures.push("omi_shadow_noise_regressed");
  if (productionReadiness.correctness.omiShadowPromotedRowCount !== 0) failures.push("omi_support_only_promoted_rows");
  if (productionReadiness.correctness.temporalMiniPassRate !== thresholds.temporalMiniPass) failures.push("temporal_mini_regressed");
  if (productionReadiness.cache.compilerWarmCacheHitRate < thresholds.compilerWarmHitRate) failures.push("compiler_cache_hit_rate_below_gate");
  if (productionReadiness.cache.compilerWarmModelRerunRate > thresholds.compilerWarmModelRerunRate) failures.push("compiler_model_rerun_rate_above_gate");
  if (productionReadiness.routePurity.broadFallbackAfterSufficientTypedSupportCount > 0) {
    failures.push("broad_fallback_after_sufficient_typed_support");
  }
  if (latestArtifactMode && process.env.BRAIN_ALLOW_LATEST_ARTIFACT_READINESS !== "1") {
    failures.push("latest_artifact_mode_blocked_for_product_gate");
  }

  const report: ProductionReadinessReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "production_readiness",
    artifactSchemaVersion: "production_readiness_v2",
    artifactMode,
    latestArtifactMode,
    manifestPath: manifestEnvelope?.manifestPath ?? null,
    passed: failures.length === 0,
    thresholds,
    artifacts: {
      longmem: longmem?.path ?? null,
      omiWatch: omiWatch?.path ?? null,
      omiShadow: omiShadow?.path ?? null,
      personalOmi: personalOmi?.path ?? null,
      temporalMini: temporalMini?.path ?? null,
      compilerCache: compilerCache?.path ?? null,
      locomo: locomo?.path ?? null
    },
    productionReadiness,
    failures,
    warnings
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `production-readiness-${stamp}.json`);
  const markdownPath = path.join(dir, `production-readiness-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runProductionReadinessBenchmarkCli(): Promise<void> {
  try {
    const manifestIndex = process.argv.indexOf("--manifest");
    const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : null;
    const result = await runAndWriteProductionReadinessBenchmark({ manifestPath });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
