import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { closePool } from "../db/client.js";
import {
  defaultCodexSessionConfig,
  listPendingCodexSessionCatalogRows,
  parseAndSummarizeCodexSession,
  projectCodexSessionSpecCoverage,
  promoteCodexSessionMemoryCandidates,
  scanCodexSessions,
  type CodexArchivePolicy
} from "../codex-sessions/service.js";
import { processVectorSyncJobs } from "../jobs/vector-sync.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function numberArg(name: string): number | undefined {
  const value = argValue(name);
  return value ? Number(value) : undefined;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const config = defaultCodexSessionConfig();
  const brainConfig = readConfig();
  const namespaceId = argValue("--namespace") ?? config.namespaceId;
  const limit = numberArg("--limit") ?? 10;
  const summarizeLimit = numberArg("--summarize-limit") ?? limit;
  const promoteLimit = numberArg("--promote-limit") ?? Math.max(limit * 20, 100);
  const projectLimit = numberArg("--project-limit") ?? promoteLimit;
  const vectorLimit = numberArg("--vector-limit") ?? Math.max(limit * 20, 100);
  const scanConfig = {
    ...config,
    namespaceId
  };
  const scan = await scanCodexSessions(scanConfig, {
    dryRun: hasFlag("--dry-run"),
    includeArchived: !hasFlag("--no-archived"),
    since: argValue("--since"),
    repo: argValue("--repo"),
    project: argValue("--project"),
    limit,
    maxBytes: numberArg("--max-bytes"),
    archivePolicy: (argValue("--archive-policy") as CodexArchivePolicy | undefined) ?? "catalog_only"
  });

  const summaryResults = [];
  if (!hasFlag("--dry-run")) {
    const pending = await listPendingCodexSessionCatalogRows(namespaceId, summarizeLimit);
    for (const row of pending) {
      const result = await parseAndSummarizeCodexSession({
        namespaceId,
        sourcePath: row.source_path,
        persist: true
      });
      summaryResults.push({
        sourcePath: row.source_path,
        parse: result.parse.metrics,
        summary: result.summary.metrics
      });
    }
  }

  const promotion = hasFlag("--dry-run")
    ? null
    : await promoteCodexSessionMemoryCandidates({ namespaceId, limit: promoteLimit });
  const projection = hasFlag("--dry-run")
    ? null
    : await projectCodexSessionSpecCoverage({ namespaceId, limit: projectLimit });
  const vectorSync = hasFlag("--dry-run")
    ? null
    : await processVectorSyncJobs({
        namespaceId,
        provider: argValue("--provider") ?? brainConfig.embeddingProvider,
        limit: vectorLimit
      });

  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_session_maintenance_run",
    namespaceId,
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun: hasFlag("--dry-run"),
    inputs: {
      repo: argValue("--repo") ?? null,
      project: argValue("--project") ?? null,
      since: argValue("--since") ?? null,
      limit,
      maxBytes: numberArg("--max-bytes") ?? null,
      summarizeLimit,
      promoteLimit,
      projectLimit,
      vectorLimit,
      archivePolicy: (argValue("--archive-policy") as CodexArchivePolicy | undefined) ?? "catalog_only",
      provider: argValue("--provider") ?? brainConfig.embeddingProvider
    },
    metrics: {
      scheduledScanCount: scan.metrics.selectedSessionCount,
      summarizedSessionCount: summaryResults.length,
      promotedCandidateCount: promotion?.insertedOrUpdatedCount ?? 0,
      projectedMemoryCount: (projection?.semanticProjectionCount ?? 0) + (projection?.proceduralProjectionCount ?? 0),
      vectorSyncQueuedCount: projection?.vectorSyncJobCount ?? 0,
      vectorSyncCoverageCount: projection?.vectorSyncCoverageCount ?? 0,
      vectorSyncClaimedCount: vectorSync?.claimed ?? 0,
      vectorSyncSyncedCount: vectorSync?.synced ?? 0,
      vectorSyncFailedCount: vectorSync?.failed ?? 0,
      rawTranscriptEmbeddingCount: projection?.rawTranscriptEmbeddingCount ?? 0,
      rawTranscriptRetrievalCount: projection?.rawTranscriptRetrievalCount ?? 0
    },
    scan,
    summaryResults,
    promotion,
    projection,
    vectorSync
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = `codex-session-maintenance-run-${stamp()}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Session Maintenance Run",
      "",
      `- namespace: ${namespaceId}`,
      `- dryRun: ${report.dryRun}`,
      `- scheduledScanCount: ${report.metrics.scheduledScanCount}`,
      `- summarizedSessionCount: ${report.metrics.summarizedSessionCount}`,
      `- promotedCandidateCount: ${report.metrics.promotedCandidateCount}`,
      `- projectedMemoryCount: ${report.metrics.projectedMemoryCount}`,
      `- vectorSyncQueuedCount: ${report.metrics.vectorSyncQueuedCount}`,
      `- vectorSyncCoverageCount: ${report.metrics.vectorSyncCoverageCount}`,
      `- vectorSyncSyncedCount: ${report.metrics.vectorSyncSyncedCount}`,
      `- vectorSyncFailedCount: ${report.metrics.vectorSyncFailedCount}`,
      `- rawTranscriptEmbeddingCount: ${report.metrics.rawTranscriptEmbeddingCount}`,
      `- rawTranscriptRetrievalCount: ${report.metrics.rawTranscriptRetrievalCount}`
    ].join("\n") + "\n",
    "utf8"
  );
  process.stdout.write(`${jsonPath}\n${markdownPath}\n${JSON.stringify({ passed: report.metrics.vectorSyncFailedCount === 0 && report.metrics.rawTranscriptEmbeddingCount === 0, metrics: report.metrics }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
