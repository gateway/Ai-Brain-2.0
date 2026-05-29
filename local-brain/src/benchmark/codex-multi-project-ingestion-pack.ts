import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";
import { normalizeProjectKey } from "../retrieval/codex-project-aliases.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { rate } from "./query-benchmark-utils.js";

const NAMESPACES = [
  { namespaceId: "codex_ai_brain_backfill_20260526_01", project: "AI Brain", minimumSummaries: 1 },
  { namespaceId: "codex_media_studio_backfill_20260526_01", project: "Media Studio", minimumSummaries: 1 }
] as const;

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function vectorSyncFailedCount(namespaceId: string): Promise<number> {
  const rows = await queryRows<{ readonly count: string }>(
    "SELECT COUNT(*)::text AS count FROM vector_sync_jobs WHERE namespace_id = $1 AND status = 'failed'",
    [namespaceId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function projectMismatchCount(namespaceId: string, project: string): Promise<number> {
  const rows = await queryRows<{ readonly count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM codex_session_summaries
      WHERE namespace_id = $1
        AND regexp_replace(lower(COALESCE(summary_json->>'project', '')), '[^a-z0-9]+', '', 'g')
          <> $2
    `,
    [namespaceId, normalizeProjectKey(project)]
  );
  return Number(rows[0]?.count ?? 0);
}

async function vectorDriftMetrics(namespaceId: string): Promise<{
  readonly staleEmbeddingModelMismatchCount: number;
  readonly pendingVectorSyncCount: number;
  readonly orphanVectorSyncJobCount: number;
}> {
  const [stale, pending, orphan] = await Promise.all([
    queryRows<{ readonly count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM semantic_memory sm
        JOIN vector_sync_jobs v
          ON v.target_table = 'semantic_memory'
         AND v.target_id = sm.id
         AND v.status = 'synced'
        WHERE sm.namespace_id = $1
          AND sm.memory_kind LIKE 'codex_%'
          AND sm.status = 'active'
          AND sm.valid_until IS NULL
          AND sm.embedding IS NOT NULL
          AND sm.embedding_model IS DISTINCT FROM v.model
      `,
      [namespaceId]
    ),
    queryRows<{ readonly count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM vector_sync_jobs
        WHERE namespace_id = $1
          AND target_table = 'semantic_memory'
          AND status IN ('pending', 'processing')
      `,
      [namespaceId]
    ),
    queryRows<{ readonly count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM vector_sync_jobs v
        LEFT JOIN semantic_memory sm
          ON sm.id = v.target_id
         AND v.target_table = 'semantic_memory'
        WHERE v.namespace_id = $1
          AND v.target_table = 'semantic_memory'
          AND sm.id IS NULL
      `,
      [namespaceId]
    )
  ]);
  return {
    staleEmbeddingModelMismatchCount: Number(stale[0]?.count ?? 0),
    pendingVectorSyncCount: Number(pending[0]?.count ?? 0),
    orphanVectorSyncJobCount: Number(orphan[0]?.count ?? 0)
  };
}

async function namespaceRow(spec: (typeof NAMESPACES)[number]): Promise<Record<string, unknown>> {
  const projection = await projectCodexSessionSpecCoverage({ namespaceId: spec.namespaceId });
  const failedVectorSyncCount = await vectorSyncFailedCount(spec.namespaceId);
  const mismatchCount = await projectMismatchCount(spec.namespaceId, spec.project);
  const drift = await vectorDriftMetrics(spec.namespaceId);
  const passed =
    projection.summaryCount >= spec.minimumSummaries &&
    projection.metrics.codexSourceEnvelopeCoverage === 1 &&
    projection.metrics.codexCuratedEmbeddingCoverage === 1 &&
    projection.rawTranscriptEmbeddingCount === 0 &&
    projection.rawTranscriptRetrievalCount === 0 &&
    failedVectorSyncCount === 0 &&
    mismatchCount === 0 &&
    drift.staleEmbeddingModelMismatchCount === 0 &&
    drift.pendingVectorSyncCount === 0 &&
    drift.orphanVectorSyncJobCount === 0;
  return {
    namespaceId: spec.namespaceId,
    project: spec.project,
    summaryCount: projection.summaryCount,
    candidateCount: projection.candidateCount,
    semanticProjectionCount: projection.semanticProjectionCount,
    vectorSyncJobCount: projection.vectorSyncJobCount,
    codexSourceEnvelopeCoverage: projection.metrics.codexSourceEnvelopeCoverage,
    curatedSemanticEmbeddingCoverage: projection.metrics.codexCuratedEmbeddingCoverage,
    rawTranscriptEmbeddingCount: projection.rawTranscriptEmbeddingCount,
    rawTranscriptRetrievalCount: projection.rawTranscriptRetrievalCount,
    vectorSyncFailedCount: failedVectorSyncCount,
    staleEmbeddingModelMismatchCount: drift.staleEmbeddingModelMismatchCount,
    pendingVectorSyncCount: drift.pendingVectorSyncCount,
    orphanVectorSyncJobCount: drift.orphanVectorSyncJobCount,
    projectMismatchCount: mismatchCount,
    passed
  };
}

export async function runCodexMultiProjectIngestionPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = await Promise.all(NAMESPACES.map(namespaceRow));
  const metrics = {
    namespaceCount: rows.length,
    passedNamespaceCount: rows.filter((row) => row.passed === true).length,
    namespacePassRate: rate(rows.filter((row) => row.passed === true).length, rows.length),
    curatedSemanticEmbeddingCoverage: rows.every((row) => Number(row.curatedSemanticEmbeddingCoverage) === 1) ? 1 : 0,
    rawTranscriptEmbeddingCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptEmbeddingCount ?? 0), 0),
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0),
    vectorSyncFailedCount: rows.reduce((sum, row) => sum + Number(row.vectorSyncFailedCount ?? 0), 0),
    staleEmbeddingModelMismatchCount: rows.reduce((sum, row) => sum + Number(row.staleEmbeddingModelMismatchCount ?? 0), 0),
    pendingVectorSyncCount: rows.reduce((sum, row) => sum + Number(row.pendingVectorSyncCount ?? 0), 0),
    orphanVectorSyncJobCount: rows.reduce((sum, row) => sum + Number(row.orphanVectorSyncJobCount ?? 0), 0),
    wrongProjectLeakCount: rows.reduce((sum, row) => sum + Number(row.projectMismatchCount ?? 0), 0)
  };
  const failures = [
    metrics.passedNamespaceCount !== metrics.namespaceCount ? "namespace_ingestion_not_green" : "",
    metrics.curatedSemanticEmbeddingCoverage !== 1 ? "embedding_coverage_miss" : "",
    metrics.rawTranscriptEmbeddingCount !== 0 ? "raw_transcript_embedding_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : "",
    metrics.vectorSyncFailedCount !== 0 ? "vector_sync_miss" : "",
    metrics.staleEmbeddingModelMismatchCount !== 0 ? "embedding_model_drift" : "",
    metrics.pendingVectorSyncCount !== 0 ? "pending_vector_sync_drift" : "",
    metrics.orphanVectorSyncJobCount !== 0 ? "orphan_vector_sync_job" : "",
    metrics.wrongProjectLeakCount !== 0 ? "wrong_project_leak" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_multi_project_ingestion_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaces: NAMESPACES.map((entry) => entry.namespaceId).join(",") }
    }),
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = `codex-multi-project-ingestion-pack-${stamp()}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Multi-Project Ingestion Pack",
      "",
      `- passed: ${report.passed}`,
      `- passedNamespaceCount: ${metrics.passedNamespaceCount}/${metrics.namespaceCount}`,
      `- curatedSemanticEmbeddingCoverage: ${metrics.curatedSemanticEmbeddingCoverage}`,
      `- rawTranscriptEmbeddingCount: ${metrics.rawTranscriptEmbeddingCount}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      `- vectorSyncFailedCount: ${metrics.vectorSyncFailedCount}`,
      `- staleEmbeddingModelMismatchCount: ${metrics.staleEmbeddingModelMismatchCount}`,
      `- pendingVectorSyncCount: ${metrics.pendingVectorSyncCount}`,
      `- orphanVectorSyncJobCount: ${metrics.orphanVectorSyncJobCount}`,
      `- wrongProjectLeakCount: ${metrics.wrongProjectLeakCount}`,
      "",
      ...rows.map((row: any) => `- ${row.namespaceId}: summaries=${row.summaryCount}, semantic=${row.semanticProjectionCount}, embeddedCoverage=${row.curatedSemanticEmbeddingCoverage}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexMultiProjectIngestionPackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexMultiProjectIngestionPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-multi-project-ingestion-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
