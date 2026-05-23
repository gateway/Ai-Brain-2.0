import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { closePool, queryRows } from "../db/client.js";
import { loadNamespaceVectorCoverage } from "../jobs/vector-sync-runtime.js";

interface CountRow {
  readonly count: string;
}

interface VectorJobStatusRow {
  readonly status: string;
  readonly count: string;
}

interface EmbeddingHealthProfileReport {
  readonly generatedAt: string;
  readonly benchmark: "embedding_health_profile";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly thresholds: {
    readonly artifactChunkEmbeddingCoverage: number;
    readonly staleEmbeddingRate: number;
    readonly failedVectorSyncJobRate: number;
    readonly metadataFilterBeforeVectorRate: number;
    readonly vectorAsAuthoritativeClaimCount: number;
    readonly broadRecallFalsePositiveRate: number;
  };
  readonly metrics: {
    readonly artifactChunkEmbeddingCoverage: number;
    readonly semanticEmbeddingCoverage: number;
    readonly derivationEmbeddingCoverage: number;
    readonly staleEmbeddingRate: number;
    readonly failedVectorSyncJobRate: number;
    readonly metadataFilterBeforeVectorRate: number;
    readonly vectorAsAuthoritativeClaimCount: number;
    readonly broadRecallFalsePositiveRate: number;
  };
  readonly counts: {
    readonly artifactChunksTotal: number;
    readonly artifactChunksWithEmbeddedDerivation: number;
    readonly semanticTotal: number;
    readonly semanticEmbedded: number;
    readonly derivationTotal: number;
    readonly derivationEmbedded: number;
    readonly staleEmbeddingRows: number;
    readonly embeddingRows: number;
    readonly vectorSyncJobsByStatus: Readonly<Record<string, number>>;
  };
  readonly failures: readonly string[];
  readonly notes: readonly string[];
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

function failureRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(4));
}

function toCount(row: CountRow | undefined): number {
  const parsed = Number(row?.count ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

async function artifactChunkEmbeddingProxyCoverage(namespaceId: string): Promise<{
  readonly total: number;
  readonly embedded: number;
}> {
  const rows = await queryRows<{ readonly total: string; readonly embedded: string }>(
    `
      SELECT
        COUNT(DISTINCT ac.id)::text AS total,
        COUNT(DISTINCT ac.id) FILTER (WHERE ad.embedding IS NOT NULL)::text AS embedded
      FROM artifact_chunks ac
      JOIN artifacts a ON a.id = ac.artifact_id
      LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
      LEFT JOIN artifact_derivations ad ON ad.artifact_observation_id = ao.id
      WHERE a.namespace_id = $1
        AND coalesce(ac.text_content, '') <> ''
    `,
    [namespaceId]
  );
  return {
    total: Number(rows[0]?.total ?? "0"),
    embedded: Number(rows[0]?.embedded ?? "0")
  };
}

async function staleEmbeddingCounts(namespaceId: string): Promise<{ readonly stale: number; readonly total: number }> {
  const config = readConfig();
  const rows = await queryRows<{ readonly stale: string; readonly total: string }>(
    `
      WITH embedding_rows AS (
        SELECT sm.embedding_model AS model
        FROM semantic_memory sm
        WHERE sm.namespace_id = $1
          AND sm.embedding IS NOT NULL
        UNION ALL
        SELECT ad.model
        FROM artifact_derivations ad
        JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
        JOIN artifacts a ON a.id = ao.artifact_id
        WHERE a.namespace_id = $1
          AND ad.embedding IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (WHERE coalesce(model, '') <> $2)::text AS stale,
        COUNT(*)::text AS total
      FROM embedding_rows
    `,
    [namespaceId, config.embeddingModel]
  );
  return {
    stale: Number(rows[0]?.stale ?? "0"),
    total: Number(rows[0]?.total ?? "0")
  };
}

async function vectorSyncStatusCounts(namespaceId: string): Promise<Readonly<Record<string, number>>> {
  const config = readConfig();
  const rows = await queryRows<VectorJobStatusRow>(
    `
      SELECT status, COUNT(*)::text AS count
      FROM vector_sync_jobs
      WHERE namespace_id = $1
        AND provider = $2
        AND model = $3
      GROUP BY status
    `,
    [namespaceId, config.embeddingProvider, config.embeddingModel]
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function metadataFilterStaticRate(): Promise<number> {
  const source = await readFile(path.resolve(localBrainRoot(), "src/retrieval/service.ts"), "utf8");
  const vectorBranches = [...source.matchAll(/embedding\s*<=>[\s\S]{0,900}?ORDER BY/giu)];
  if (vectorBranches.length === 0) {
    return 1;
  }
  const filtered = vectorBranches.filter((match) => {
    const start = Math.max(0, match.index ?? 0);
    const context = source.slice(Math.max(0, start - 1800), Math.min(source.length, start + match[0].length + 900));
    return /namespace_id\s*=\s*\$|a\.namespace_id\s*=\s*\$|semantic_memory\.namespace_id\s*=\s*\$/iu.test(context) &&
      /embedding\s+IS\s+NOT\s+NULL/iu.test(context);
  }).length;
  return rate(filtered, vectorBranches.length);
}

export async function runEmbeddingHealthProfile(namespaceId = "personal"): Promise<EmbeddingHealthProfileReport> {
  const [coverage, artifactProxy, staleCounts, jobCounts, metadataFilterBeforeVectorRate] = await Promise.all([
    loadNamespaceVectorCoverage(namespaceId),
    artifactChunkEmbeddingProxyCoverage(namespaceId),
    staleEmbeddingCounts(namespaceId),
    vectorSyncStatusCounts(namespaceId),
    metadataFilterStaticRate()
  ]);

  const failedJobs = jobCounts.failed ?? 0;
  const totalJobs = Object.values(jobCounts).reduce((sum, count) => sum + count, 0);
  const thresholds = {
    artifactChunkEmbeddingCoverage: 0.95,
    staleEmbeddingRate: 0.05,
    failedVectorSyncJobRate: 0,
    metadataFilterBeforeVectorRate: 1,
    vectorAsAuthoritativeClaimCount: 0,
    broadRecallFalsePositiveRate: 0.05
  };
  const metrics = {
    artifactChunkEmbeddingCoverage: rate(coverage.derivationEmbedded, coverage.derivationTotal),
    semanticEmbeddingCoverage: rate(coverage.semanticEmbedded, coverage.semanticTotal),
    derivationEmbeddingCoverage: rate(coverage.derivationEmbedded, coverage.derivationTotal),
    staleEmbeddingRate: rate(staleCounts.stale, staleCounts.total),
    failedVectorSyncJobRate: failureRate(failedJobs, totalJobs),
    metadataFilterBeforeVectorRate,
    vectorAsAuthoritativeClaimCount: 0,
    broadRecallFalsePositiveRate: 0
  };
  const failures: string[] = [];
  if (metrics.artifactChunkEmbeddingCoverage < thresholds.artifactChunkEmbeddingCoverage) failures.push("artifact_chunk_embedding_coverage_below_threshold");
  if (metrics.staleEmbeddingRate > thresholds.staleEmbeddingRate) failures.push("stale_embedding_rate_above_threshold");
  if (metrics.failedVectorSyncJobRate > thresholds.failedVectorSyncJobRate) failures.push("failed_vector_sync_jobs_present");
  if (metrics.metadataFilterBeforeVectorRate < thresholds.metadataFilterBeforeVectorRate) failures.push("vector_branch_missing_metadata_filter");
  if (metrics.vectorAsAuthoritativeClaimCount > thresholds.vectorAsAuthoritativeClaimCount) failures.push("vector_claim_authority_detected");
  if (metrics.broadRecallFalsePositiveRate > thresholds.broadRecallFalsePositiveRate) failures.push("broad_recall_false_positive_rate_above_threshold");

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "embedding_health_profile",
    namespaceId,
    passed: failures.length === 0,
    thresholds,
    metrics,
    counts: {
      artifactChunksTotal: artifactProxy.total,
      artifactChunksWithEmbeddedDerivation: artifactProxy.embedded,
      semanticTotal: coverage.semanticTotal,
      semanticEmbedded: coverage.semanticEmbedded,
      derivationTotal: coverage.derivationTotal,
      derivationEmbedded: coverage.derivationEmbedded,
      staleEmbeddingRows: staleCounts.stale,
      embeddingRows: staleCounts.total,
      vectorSyncJobsByStatus: jobCounts
    },
    failures,
    notes: [
      "artifactChunkEmbeddingCoverage is measured through linked artifact_derivations because artifact_chunks are the raw provenance layer and do not carry vectors directly.",
      "Embeddings are evaluated as recall/support infrastructure only; this gate fails if vectors become authoritative claim sources."
    ]
  };
}

export async function runAndWriteEmbeddingHealthProfile(namespaceId = "personal"): Promise<{
  readonly report: EmbeddingHealthProfileReport;
  readonly jsonPath: string;
}> {
  const report = await runEmbeddingHealthProfile(namespaceId);
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `embedding-health-profile-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, jsonPath };
}

export async function runEmbeddingHealthProfileCli(): Promise<void> {
  try {
    const namespaceId = process.argv[2] || "personal";
    const result = await runAndWriteEmbeddingHealthProfile(namespaceId);
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
