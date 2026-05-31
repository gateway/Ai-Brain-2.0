import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexMultiProjectIngestionPack } from "./codex-multi-project-ingestion-pack.js";
import { runCodexMultiProjectQueryAudit } from "./codex-multi-project-query-audit.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { runAndWriteSourceTopicReportPack } from "./source-topic-report-pack.js";
import { rate } from "./query-benchmark-utils.js";

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function toMarkdown(report: any): string {
  return [
    "# Cross-Source Project Memory Pack",
    "",
    `- passed: ${report.passed}`,
    `- crossSourceProjectPassRate: ${report.metrics.crossSourceProjectPassRate}`,
    `- projectAliasLeakCount: ${report.metrics.projectAliasLeakCount}`,
    `- rawTranscriptRetrievalCount: ${report.metrics.rawTranscriptRetrievalCount}`,
    `- supportedEmptySourceTrailCount: ${report.metrics.supportedEmptySourceTrailCount}`,
    `- supportedMissingClaimAuditCount: ${report.metrics.supportedMissingClaimAuditCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Dependency Artifacts",
    "",
    ...Object.entries(report.dependencyArtifacts).map(([key, value]) => `- ${key}: ${value}`)
  ].join("\n") + "\n";
}

export async function runAndWriteCrossSourceProjectMemoryPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const [codexIngestion, codexQueryAudit, multiSource, sourceTopic] = await Promise.all([
    runCodexMultiProjectIngestionPack(),
    runCodexMultiProjectQueryAudit(),
    runAndWriteMultiSourceIngestionPack(),
    runAndWriteSourceTopicReportPack()
  ]);
  const codexRows = codexQueryAudit.report.rows ?? [];
  const supportedCodexRows = codexRows.filter((row: any) => row.expectedSupport !== "abstained");
  const sourceTopicRows = sourceTopic.report.results ?? [];
  const multiRows = multiSource.report.results ?? [];
  const projectRows = [
    ...codexRows.map((row: any) => ({ source: "codex", passed: row.passed === true, row })),
    ...sourceTopicRows.map((row: any) => ({ source: "source_topic", passed: row.passed === true, row })),
    ...multiRows.filter((row: any) => row.sourceKindFamily === "dossier").map((row: any) => ({ source: "multi_source", passed: row.passed === true, row }))
  ];
  const metrics = {
    projectQueryCount: projectRows.length,
    projectQueryStrongCount: projectRows.filter((row) => row.passed).length,
    crossSourceProjectPassRate: rate(projectRows.filter((row) => row.passed).length, projectRows.length),
    codexProjectNamespacePassRate: codexIngestion.report.metrics?.namespacePassRate ?? 0,
    codexQueryStrongRate: codexQueryAudit.report.metrics?.strongRate ?? rate(codexRows.filter((row: any) => row.passed === true).length, codexRows.length),
    sourceTopicPassRate: rate(sourceTopicRows.filter((row: any) => row.passed === true).length, sourceTopicRows.length),
    multiSourceDossierPassRate: multiSource.report.metrics?.crossSourceDossierPassRate ?? 0,
    projectAliasLeakCount: codexIngestion.report.metrics?.wrongProjectLeakCount ?? 0,
    rawTranscriptRetrievalCount:
      (codexIngestion.report.metrics?.rawTranscriptRetrievalCount ?? 0) + (codexQueryAudit.report.metrics?.rawTranscriptRetrievalCount ?? 0),
    supportedEmptySourceTrailCount:
      (codexQueryAudit.report.metrics?.supportedEmptySourceTrailRows ?? 0) +
      supportedCodexRows.filter((row: any) => Number(row.sourceTrailCount ?? 0) === 0).length +
      multiRows.filter((row: any) => Number(row.evidenceCount ?? 0) > 0 && Number(row.sourceTrailCount ?? 0) === 0).length,
    supportedMissingClaimAuditCount:
      (codexQueryAudit.report.metrics?.supportedMissingClaimAuditRows ?? 0) +
      supportedCodexRows.filter((row: any) => Number(row.claimAuditCount ?? 0) === 0).length +
      multiRows.filter((row: any) => Number(row.evidenceCount ?? 0) > 0 && Number(row.claimAuditCount ?? 0) === 0).length,
    queryTimeModelCalls:
      (codexQueryAudit.report.metrics?.queryTimeModelCalls ?? 0) +
      (multiSource.report.metrics?.queryTimeModelCalls ?? 0)
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "cross_source_project_memory_pack",
    passed:
      codexIngestion.report.passed === true &&
      codexQueryAudit.report.passed === true &&
      multiSource.report.passed === true &&
      sourceTopic.report.passed === true &&
      metrics.crossSourceProjectPassRate >= 0.95 &&
      metrics.codexProjectNamespacePassRate === 1 &&
      metrics.multiSourceDossierPassRate >= 0.95 &&
      metrics.projectAliasLeakCount === 0 &&
      metrics.rawTranscriptRetrievalCount === 0 &&
      metrics.supportedEmptySourceTrailCount === 0 &&
      metrics.supportedMissingClaimAuditCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    dependencyArtifacts: {
      codexMultiProjectIngestionPack: codexIngestion.output.jsonPath,
      codexMultiProjectQueryAudit: codexQueryAudit.output.jsonPath,
      codexMultiProjectMissLedger: codexQueryAudit.output.missLedgerJsonPath,
      multiSourceIngestionPack: multiSource.output.jsonPath,
      sourceTopicReportPack: sourceTopic.output.jsonPath
    }
  };
  await mkdir(outputDir(), { recursive: true });
  const suffix = stamp();
  const jsonPath = path.join(outputDir(), `cross-source-project-memory-pack-${suffix}.json`);
  const markdownPath = path.join(outputDir(), `cross-source-project-memory-pack-${suffix}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCrossSourceProjectMemoryPackCli(): Promise<void> {
  const { report, output } = await runAndWriteCrossSourceProjectMemoryPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
