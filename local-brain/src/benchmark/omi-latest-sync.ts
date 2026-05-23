import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { getMonitoredSourcePreview, importMonitoredSource, scanMonitoredSource } from "../ops/source-service.js";
import {
  runTaxonomyTemporalBackfill,
  writeTaxonomyTemporalBackfillReport,
  type TaxonomyTemporalBackfillReport
} from "../taxonomy-temporal/backfill.js";

interface OmiSourceRow {
  readonly id: string;
  readonly namespace_id: string;
  readonly label: string;
  readonly root_path: string;
}

interface ArtifactVerificationRow {
  readonly artifact_id: string;
  readonly artifact_uri: string;
  readonly artifact_type: string;
  readonly source_channel: string | null;
  readonly chunk_count: number;
  readonly episodic_import_count: number;
  readonly narrative_scene_count: number;
}

interface OmiLatestSyncReport {
  readonly generatedAt: string;
  readonly source: {
    readonly id: string;
    readonly namespaceId: string;
    readonly label: string;
    readonly rootPath: string;
  };
  readonly latestFile: {
    readonly fileId: string;
    readonly relativePath: string;
    readonly absolutePath: string;
    readonly modifiedAt: string | null;
    readonly statusBeforeImport: string;
    readonly statusAfterImport: string | null;
    readonly artifactId: string | null;
  };
  readonly importRun: {
    readonly id: string;
    readonly status: string;
    readonly filesAttempted: number;
    readonly filesImported: number;
    readonly filesFailed: number;
    readonly relationIe: unknown;
  };
  readonly artifactVerification: ArtifactVerificationRow | null;
  readonly compilerDryRun: {
    readonly artifactPath: string;
    readonly summary: TaxonomyTemporalBackfillReport["summary"];
    readonly qualityGate: TaxonomyTemporalBackfillReport["qualityGate"];
  } | null;
  readonly compilerPersist: {
    readonly artifactPath: string;
    readonly summary: TaxonomyTemporalBackfillReport["summary"];
    readonly qualityGate: TaxonomyTemporalBackfillReport["qualityGate"];
    readonly persistenceCheck: TaxonomyTemporalBackfillReport["persistenceCheck"];
  } | null;
  readonly stageTimingsMs: Readonly<Record<string, number>>;
  readonly passed: boolean;
  readonly blockedStage: string | null;
  readonly blockedStageReason: string | null;
}

export interface RunOmiLatestSyncOptions {
  readonly sourceId?: string;
  readonly namespaceId?: string;
  readonly compilerLimit?: number;
  readonly persistCompiler?: boolean;
  readonly forceImport?: boolean;
  readonly skipCompiler?: boolean;
  readonly runSourceRelationIe?: boolean;
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

function nowIso(): string {
  return new Date().toISOString();
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function loadOmiSource(options: RunOmiLatestSyncOptions): Promise<OmiSourceRow> {
  const rows = await queryRows<OmiSourceRow>(
    `
      SELECT id::text, namespace_id, label, root_path
      FROM ops.monitored_sources
      WHERE ($1::uuid IS NULL OR id = $1::uuid)
        AND ($2::text IS NULL OR namespace_id = $2)
        AND (
          metadata->>'producer' = 'omi_sync'
          OR label ILIKE '%omi%'
          OR root_path ILIKE '%omi-archive%normalized%'
        )
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [options.sourceId ?? null, options.namespaceId ?? null]
  );
  if (!rows[0]) {
    throw new Error("No OMI monitored source found. Provide --source-id if the source is not discoverable.");
  }
  return rows[0];
}

function selectLatestFile(preview: Awaited<ReturnType<typeof getMonitoredSourcePreview>>): Awaited<ReturnType<typeof getMonitoredSourcePreview>>["files"][number] {
  const latest = [...preview.files]
    .filter((file) => file.existsNow && (file.extension === ".md" || file.extension === ".txt"))
    .sort((left, right) => {
      const byModified = asString(right.modifiedAt).localeCompare(asString(left.modifiedAt));
      return byModified !== 0 ? byModified : right.relativePath.localeCompare(left.relativePath);
    })[0];
  if (!latest) {
    throw new Error(`No importable OMI files found for source ${preview.source.id}.`);
  }
  return latest;
}

async function verifyArtifact(artifactId: string | null | undefined): Promise<ArtifactVerificationRow | null> {
  if (!artifactId) {
    return null;
  }
  const rows = await queryRows<ArtifactVerificationRow>(
    `
      SELECT
        artifact.id::text AS artifact_id,
        artifact.uri AS artifact_uri,
        artifact.artifact_type,
        artifact.source_channel,
        COALESCE(chunk_counts.total, 0)::int AS chunk_count,
        COALESCE(memory_counts.total, 0)::int AS episodic_import_count,
        COALESCE(scene_counts.total, 0)::int AS narrative_scene_count
      FROM artifacts artifact
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM artifact_chunks chunk
        WHERE chunk.artifact_id = artifact.id
      ) chunk_counts ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM episodic_memory memory
        JOIN artifact_chunks chunk ON chunk.id = memory.source_chunk_id
        WHERE chunk.artifact_id = artifact.id
          AND memory.role = 'import'
      ) memory_counts ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total
        FROM narrative_scenes scene
        WHERE scene.artifact_id = artifact.id
      ) scene_counts ON true
      WHERE artifact.id = $1::uuid
      LIMIT 1
    `,
    [artifactId]
  );
  return rows[0] ?? null;
}

async function writeOmiLatestSyncReport(report: OmiLatestSyncReport): Promise<string> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `omi-latest-sync-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return jsonPath;
}

export async function runOmiLatestSync(options: RunOmiLatestSyncOptions = {}): Promise<{
  readonly artifactPath: string;
  readonly report: OmiLatestSyncReport;
}> {
  const stageTimings = new Map<string, number>();
  let blockedStage: string | null = null;
  let blockedStageReason: string | null = null;
  const source = await loadOmiSource(options);

  const scanStartedAt = performance.now();
  const scanned = await scanMonitoredSource(source.id);
  stageTimings.set("scan", elapsed(scanStartedAt));
  const beforeLatest = selectLatestFile(scanned);

  const importStartedAt = performance.now();
  const imported = await importMonitoredSource(source.id, "manual", [beforeLatest.id], {
    forceImport: options.forceImport === true,
    skipPostImportRefresh: true,
    skipVectorActivation: true,
    skipRelationIeEnrichment: options.runSourceRelationIe !== true
  });
  stageTimings.set("import_latest_file", elapsed(importStartedAt));

  const afterPreview = await getMonitoredSourcePreview(source.id);
  const afterLatest = afterPreview.files.find((file) => file.id === beforeLatest.id) ?? beforeLatest;
  const artifactVerification = await verifyArtifact(afterLatest.artifactId);
  if (!artifactVerification || artifactVerification.chunk_count === 0) {
    blockedStage = "artifact_verification";
    blockedStageReason = "latest_file_missing_artifact_or_chunks";
  }

  let dryRun: TaxonomyTemporalBackfillReport | null = null;
  let dryRunPath: string | null = null;
  const compilerOptions = {
    namespaceId: source.namespace_id,
    limit: options.compilerLimit ?? 4,
    sourceUriContains: beforeLatest.relativePath,
    dryRun: true,
    skipProcessed: false,
    latestFirst: true
  } as const;
  if (options.skipCompiler !== true) {
    const dryRunStartedAt = performance.now();
    dryRun = await runTaxonomyTemporalBackfill(compilerOptions);
    dryRunPath = await writeTaxonomyTemporalBackfillReport(dryRun);
    stageTimings.set("compiler_dry_run", elapsed(dryRunStartedAt));
    if (!dryRun.qualityGate.passed && blockedStage === null) {
      blockedStage = "compiler_dry_run";
      blockedStageReason = dryRun.qualityGate.failures.join(",") || "quality_gate_failed";
    }
  }

  let persisted: TaxonomyTemporalBackfillReport | null = null;
  let persistedPath: string | null = null;
  if (options.persistCompiler === true && dryRun?.qualityGate.passed === true) {
    const persistStartedAt = performance.now();
    persisted = await runTaxonomyTemporalBackfill({
      ...compilerOptions,
      dryRun: false
    });
    persistedPath = await writeTaxonomyTemporalBackfillReport(persisted);
    stageTimings.set("compiler_persist", elapsed(persistStartedAt));
    if (!persisted.qualityGate.passed && blockedStage === null) {
      blockedStage = "compiler_persist";
      blockedStageReason = persisted.qualityGate.failures.join(",") || "quality_gate_failed";
    }
  }

  const report: OmiLatestSyncReport = {
    generatedAt: nowIso(),
    source: {
      id: source.id,
      namespaceId: source.namespace_id,
      label: source.label,
      rootPath: source.root_path
    },
    latestFile: {
      fileId: beforeLatest.id,
      relativePath: beforeLatest.relativePath,
      absolutePath: beforeLatest.absolutePath,
      modifiedAt: beforeLatest.modifiedAt ?? null,
      statusBeforeImport: beforeLatest.lastStatus,
      statusAfterImport: afterLatest.lastStatus ?? null,
      artifactId: afterLatest.artifactId ?? null
    },
    importRun: {
      id: imported.importRun.id,
      status: imported.importRun.status,
      filesAttempted: imported.importRun.filesAttempted,
      filesImported: imported.importRun.filesImported,
      filesFailed: imported.importRun.filesFailed,
      relationIe: imported.importRun.result.relation_ie ?? null
    },
    artifactVerification,
    compilerDryRun: dryRun && dryRunPath
      ? {
          artifactPath: dryRunPath,
          summary: dryRun.summary,
          qualityGate: dryRun.qualityGate
        }
      : null,
    compilerPersist: persisted && persistedPath
      ? {
          artifactPath: persistedPath,
          summary: persisted.summary,
          qualityGate: persisted.qualityGate,
          persistenceCheck: persisted.persistenceCheck
        }
      : null,
    stageTimingsMs: Object.fromEntries(stageTimings),
    passed: blockedStage === null,
    blockedStage,
    blockedStageReason
  };
  const artifactPath = await writeOmiLatestSyncReport(report);
  return { artifactPath, report };
}
