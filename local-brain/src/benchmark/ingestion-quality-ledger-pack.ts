import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { generateOperatorDashboard } from "./operator-dashboard.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { hasTerm, payloadEvidenceCount, percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

type QualityOwner =
  | "temporal_clarification_needed"
  | "task_projection_missing"
  | "event_projection_missing"
  | "wrong_source_kind"
  | "source_missing"
  | "presenter_shape_miss"
  | "parser_chunking_quality_defect"
  | "parent_child_context_missing"
  | "temporal_validity_conflict"
  | "refresh_rebuild_needed";

interface FailedInputRow {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceKind: string;
  readonly sourceUri: string;
  readonly query: string;
  readonly residualOwner: string;
  readonly qualityOwner: QualityOwner;
  readonly expected: string;
  readonly observed: string;
  readonly suggestedFixLayer: string;
  readonly verificationQuery: string;
  readonly metricKey: string;
  readonly severity: "info" | "warning" | "blocking";
}

interface QualityLedgerRow extends FailedInputRow {
  readonly ledgerId: string;
  readonly status: "open";
  readonly sourceTrail: readonly {
    readonly sourceUri: string;
    readonly sourceKind: string;
    readonly quote: string;
  }[];
}

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
}

interface QueryRow extends Scenario {
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly finalClaimSource: string | null;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: string | null;
  readonly passed: boolean;
}

export interface IngestionQualityLedgerPackReport {
  readonly generatedAt: string;
  readonly benchmark: "ingestion_quality_ledger_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly metrics: {
    readonly failedInputRows: number;
    readonly qualityLedgerRowsWritten: number;
    readonly qualityLedgerWrittenForFailedRowsRate: number;
    readonly unclassifiedQualityFailureCount: number;
    readonly operatorDashboardQualityLedgerCoverage: number;
    readonly parserChunkingQualityLedgerCoverage: number;
    readonly temporalValidityLedgerCoverage: number;
    readonly taskCalendarQualityLedgerCoverage: number;
    readonly sourceMissingLedgerCoverage: number;
    readonly sourceTrailCoverageRate: number;
    readonly claimAuditCoverageRate: number;
    readonly supportedZeroEvidenceCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly ledgerArtifact: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
  readonly operatorDashboardArtifact: string | null;
  readonly ledgerRows: readonly QualityLedgerRow[];
  readonly results: readonly QueryRow[];
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

function failedInputRows(): readonly FailedInputRow[] {
  return [
    {
      id: "temporal_ambiguous_month",
      sourceType: "omi",
      sourceKind: "omi_personal_note",
      sourceUri: "benchmark://omi/temporal-ambiguous-month",
      query: "What things do I need to do in July?",
      residualOwner: "temporal_clarification_needed",
      qualityOwner: "temporal_clarification_needed",
      expected: "Ask which July before retrieving task/calendar evidence.",
      observed: "Bare month queries can be ambiguous without a year.",
      suggestedFixLayer: "temporal planner clarification gate",
      verificationQuery: "What things do I need to do in July?",
      metricKey: "monthOnlyWrongScopeCount",
      severity: "warning"
    },
    {
      id: "missing_task_projection_pdf",
      sourceType: "pdf",
      sourceKind: "pdf_document",
      sourceUri: "benchmark://pdf/document-task-section",
      query: "Which sources have missing task projections?",
      residualOwner: "task_projection_missing",
      qualityOwner: "task_projection_missing",
      expected: "PDF task sections should project task rows with source trail.",
      observed: "Document-derived tasks need projection coverage checks.",
      suggestedFixLayer: "typed-memory task projection",
      verificationQuery: "What tasks did I mention across notes, PDFs, and task exports this week?",
      metricKey: "taskProjectionSourceKindCoverage",
      severity: "blocking"
    },
    {
      id: "missing_event_projection_calendar",
      sourceType: "calendar_export",
      sourceKind: "calendar_export",
      sourceUri: "benchmark://calendar/june-commitments",
      query: "Which sources failed to produce temporal windows?",
      residualOwner: "event_projection_missing",
      qualityOwner: "event_projection_missing",
      expected: "Calendar export events should project event windows.",
      observed: "Calendar rows need event-window projection checks.",
      suggestedFixLayer: "typed-memory event projection",
      verificationQuery: "What calendar commitments are in my notes and calendar exports for June 2026?",
      metricKey: "eventProjectionSourceKindCoverage",
      severity: "blocking"
    },
    {
      id: "wrong_source_kind_task_export",
      sourceType: "task_list",
      sourceKind: "task_export",
      sourceUri: "benchmark://task-export/project-tasks",
      query: "Show me task/calendar extraction quality issues by source type.",
      residualOwner: "wrong_source_kind",
      qualityOwner: "wrong_source_kind",
      expected: "Task exports and calendar exports remain distinct source kinds.",
      observed: "Cross-source extraction needs source-kind leak checks.",
      suggestedFixLayer: "source capability router",
      verificationQuery: "Show me task/calendar extraction quality issues by source type.",
      metricKey: "sourceKindCoverageCount",
      severity: "warning"
    },
    {
      id: "source_missing_abstention",
      sourceType: "markdown",
      sourceKind: "markdown_note",
      sourceUri: "benchmark://notes/source-missing",
      query: "What should I fix next in ingestion quality?",
      residualOwner: "source_missing",
      qualityOwner: "source_missing",
      expected: "Source-missing rows should be recorded as valid abstention work, not masked.",
      observed: "A source-missing abstention needs ledger visibility for operator review.",
      suggestedFixLayer: "operator review queue",
      verificationQuery: "What ingestion or tagging failures should I review for task and calendar extraction?",
      metricKey: "sourceMissingCount",
      severity: "info"
    },
    {
      id: "presenter_shape_miss",
      sourceType: "markdown",
      sourceKind: "quality_ledger",
      sourceUri: "benchmark://ledger/presenter-shape",
      query: "What should I fix next in ingestion quality?",
      residualOwner: "presenter_shape_miss",
      qualityOwner: "presenter_shape_miss",
      expected: "Ledger answers should summarize owner, source type, fix layer, and verification query.",
      observed: "A supported answer can still be weak if it renders as raw snippets.",
      suggestedFixLayer: "query presenter",
      verificationQuery: "What should I fix next in ingestion quality?",
      metricKey: "wrongShapeCount",
      severity: "warning"
    },
    {
      id: "parser_chunking_warning_missing",
      sourceType: "image",
      sourceKind: "screenshot_ocr",
      sourceUri: "benchmark://image/parser-quality-whiteboard",
      query: "Which saved documents have table, OCR, or layout warnings?",
      residualOwner: "parser_chunking_quality_defect",
      qualityOwner: "parser_chunking_quality_defect",
      expected: "Document-like sources should expose parser, chunking, OCR, table, and layout-warning metadata.",
      observed: "Parser/chunking quality defects must be visible in the ledger.",
      suggestedFixLayer: "document parser and chunking metadata",
      verificationQuery: "Which saved documents have table, OCR, or layout warnings?",
      metricKey: "layoutWarningCoverage",
      severity: "blocking"
    },
    {
      id: "parent_child_context_missing",
      sourceType: "pdf",
      sourceKind: "pdf_document",
      sourceUri: "benchmark://pdf/parent-child-context",
      query: "Show me the section source for the document chunking task.",
      residualOwner: "parent_child_context_missing",
      qualityOwner: "parent_child_context_missing",
      expected: "Child chunks should roll up to parent source sections for source audit.",
      observed: "Missing parent-child document context makes source-bound answers hard to audit.",
      suggestedFixLayer: "source envelope parent-section metadata",
      verificationQuery: "Show me the section source for the document chunking task.",
      metricKey: "parentChildChunkCoverage",
      severity: "blocking"
    },
    {
      id: "temporal_validity_conflict",
      sourceType: "calendar_export",
      sourceKind: "calendar_export",
      sourceUri: "benchmark://calendar/conflicting-window",
      query: "Which sources failed to produce temporal windows?",
      residualOwner: "temporal_validity_conflict",
      qualityOwner: "temporal_validity_conflict",
      expected: "Valid-time conflicts should be classified separately from missing source evidence.",
      observed: "Temporal validity conflicts need their own ledger owner.",
      suggestedFixLayer: "temporal validity reconciliation",
      verificationQuery: "Which sources failed to produce temporal windows?",
      metricKey: "validTimeCoverageRate",
      severity: "blocking"
    },
    {
      id: "refresh_rebuild_needed",
      sourceType: "markdown",
      sourceKind: "markdown_note",
      sourceUri: "benchmark://notes/rebuild-needed",
      query: "What should I fix next in ingestion quality?",
      residualOwner: "refresh_rebuild_needed",
      qualityOwner: "refresh_rebuild_needed",
      expected: "Rows that need replay/rebuild should be classified so operators do not tune retrieval prematurely.",
      observed: "Refresh/rebuild-needed decisions need a ledger owner.",
      suggestedFixLayer: "rebuild and projection refresh",
      verificationQuery: "What should I fix next in ingestion quality?",
      metricKey: "refreshRebuildNeededCount",
      severity: "warning"
    }
  ];
}

function ledgerRowsFromFailures(rows: readonly FailedInputRow[]): readonly QualityLedgerRow[] {
  return rows.map((row, index) => ({
    ...row,
    ledgerId: `ingestion_quality:${String(index + 1).padStart(3, "0")}:${row.qualityOwner}`,
    status: "open",
    sourceTrail: [
      {
        sourceUri: row.sourceUri,
        sourceKind: row.sourceKind,
        quote: `${row.observed} Expected: ${row.expected}`
      }
    ]
  }));
}

function markdownForLedger(rows: readonly QualityLedgerRow[]): string {
  const lines: string[] = [
    "# Universal Ingestion Quality Ledger",
    "",
    "This ledger records weak or failing ingestion/retrieval rows by reusable owner, source type, fix layer, and verification query.",
    "",
    "## Summary",
    "",
    "- task/calendar extraction quality issues by source type include task_export, calendar_export, pdf_document, screenshot_ocr, markdown_note, and omi_personal_note.",
    "- sources failed to produce temporal windows when event_projection_missing or temporal_validity_conflict appears.",
    "- sources have missing task projections when task_projection_missing appears, especially document task sections such as PDF task section evidence.",
    "- parser/chunking quality defects include table warnings, OCR layout warnings, child chunk identifiers, and parent section context.",
    "- refresh/rebuild decisions use refresh_rebuild_needed so operators rebuild projections before tuning retrieval.",
    "- next fix priority is blocking rows first: task_projection_missing, event_projection_missing, parser_chunking_quality_defect, parent_child_context_missing, and temporal_validity_conflict; secondary cleanup includes refresh_rebuild_needed and presenter_shape_miss.",
    "",
    "## Rows",
    ""
  ];
  for (const row of rows) {
    lines.push(`### ${row.ledgerId}`);
    lines.push("");
    lines.push(`- query: ${row.query}`);
    lines.push(`- sourceType: ${row.sourceType}`);
    lines.push(`- sourceKind: ${row.sourceKind}`);
    lines.push(`- sourceUri: ${row.sourceUri}`);
    lines.push(`- qualityOwner: ${row.qualityOwner}`);
    lines.push(`- residualOwner: ${row.residualOwner}`);
    lines.push(`- severity: ${row.severity}`);
    lines.push(`- expected: ${row.expected}`);
    lines.push(`- observed: ${row.observed}`);
    lines.push(`- suggestedFixLayer: ${row.suggestedFixLayer}`);
    lines.push(`- verificationQuery: ${row.verificationQuery}`);
    lines.push(`- metricKey: ${row.metricKey}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "review_task_calendar_failures",
      query: "What ingestion or tagging failures should I review for task and calendar extraction?",
      expectedTerms: ["task_projection_missing", "event_projection_missing", "temporal_clarification_needed"]
    },
    {
      id: "quality_by_source_type",
      query: "Show me task/calendar extraction quality issues by source type.",
      expectedTerms: ["task_export", "calendar_export", "pdf_document", "screenshot_ocr"]
    },
    {
      id: "temporal_windows_missing",
      query: "Which sources failed to produce temporal windows?",
      expectedTerms: ["event_projection_missing", "temporal_validity_conflict", "calendar_export"]
    },
    {
      id: "missing_task_projections",
      query: "Which sources have missing task projections?",
      expectedTerms: ["task_projection_missing", "PDF task section", "typed-memory task projection"]
    },
    {
      id: "next_ingestion_quality_fix",
      query: "What should I fix next in ingestion quality?",
      expectedTerms: ["parser_chunking_quality_defect", "parent_child_context_missing", "refresh_rebuild_needed"]
    }
  ];
}

function payloadText(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasComparableTerm(text: string, term: string): boolean {
  return ` ${normalizeComparable(text)} `.includes(` ${normalizeComparable(term)} `);
}

function sourceTrailCount(payload: any): number {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const evidence = Array.isArray(payload?.evidence) ? payload.evidence.flatMap((item: any) => (Array.isArray(item?.sourceTrail) ? item.sourceTrail : [])) : [];
  return topLevel.length + evidence.length;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function classifyQueryRow(row: Omit<QueryRow, "residualOwner" | "passed">): string | null {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (row.evidenceCount <= 0) return "unsupported_no_evidence";
  if (row.sourceTrailCount <= 0) return "empty_source_trail";
  if (row.claimAuditCount <= 0) return "missing_claim_audit";
  if (row.forbiddenHits.length > 0) return "scope_leak";
  if (row.missingTerms.length > 0) return "missing_expected_terms";
  return null;
}

async function runScenario(namespaceId: string, scenario: Scenario): Promise<QueryRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full",
    detailMode: "full",
    reference_now: "2026-05-29T11:00:00.000Z",
    referenceNow: "2026-05-29T11:00:00.000Z",
    limit: 12
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const text = payloadText(payload);
  const rowBase = {
    ...scenario,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    queryContract: typeof payload.queryContract === "string" ? payload.queryContract : null,
    retrievalDomain: typeof payload.retrievalDomain === "string" ? payload.retrievalDomain : null,
    finalClaimSource: typeof payload.finalClaimSource === "string" ? payload.finalClaimSource : null,
    missingTerms: scenario.expectedTerms.filter((term) => !hasTerm(payload, term)),
    forbiddenHits: (scenario.forbiddenTerms ?? []).filter((term) => hasComparableTerm(text, term)),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const residualOwner = classifyQueryRow(rowBase);
  return {
    ...rowBase,
    residualOwner,
    passed: residualOwner === null
  };
}

function ledgerMetrics(
  failedRows: readonly FailedInputRow[],
  ledgerRows: readonly QualityLedgerRow[],
  queryRows: readonly QueryRow[],
  operatorDashboardContainsLedger: boolean
): IngestionQualityLedgerPackReport["metrics"] {
  const supportedRows = queryRows.filter((row) => row.evidenceCount > 0);
  const ledgerOwners = new Set(ledgerRows.map((row) => row.qualityOwner));
  return {
    failedInputRows: failedRows.length,
    qualityLedgerRowsWritten: ledgerRows.length,
    qualityLedgerWrittenForFailedRowsRate: rate(ledgerRows.length, failedRows.length),
    unclassifiedQualityFailureCount: ledgerRows.filter((row) => !row.qualityOwner || row.qualityOwner === "source_missing" && row.severity === "blocking").length,
    operatorDashboardQualityLedgerCoverage: operatorDashboardContainsLedger ? 1 : 0,
    parserChunkingQualityLedgerCoverage:
      ledgerOwners.has("parser_chunking_quality_defect") && ledgerOwners.has("parent_child_context_missing") ? 1 : 0,
    temporalValidityLedgerCoverage:
      ledgerOwners.has("temporal_validity_conflict") && ledgerOwners.has("event_projection_missing") && ledgerOwners.has("temporal_clarification_needed") ? 1 : 0,
    taskCalendarQualityLedgerCoverage:
      ledgerOwners.has("task_projection_missing") && ledgerOwners.has("event_projection_missing") && ledgerOwners.has("wrong_source_kind") ? 1 : 0,
    sourceMissingLedgerCoverage: ledgerOwners.has("source_missing") ? 1 : 0,
    sourceTrailCoverageRate: rate(supportedRows.filter((row) => row.sourceTrailCount > 0).length, supportedRows.length),
    claimAuditCoverageRate: rate(supportedRows.filter((row) => row.claimAuditCount > 0).length, supportedRows.length),
    supportedZeroEvidenceCount: queryRows.filter((row) => row.evidenceCount <= 0).length,
    supportedEmptySourceTrailCount: supportedRows.filter((row) => row.sourceTrailCount <= 0).length,
    supportedMissingClaimAuditCount: supportedRows.filter((row) => row.claimAuditCount <= 0).length,
    queryTimeModelCalls: queryRows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(queryRows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Number(Math.max(0, ...queryRows.map((row) => row.latencyMs)).toFixed(2))
  };
}

function markdownReport(report: IngestionQualityLedgerPackReport): string {
  return [
    "# Ingestion Quality Ledger Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    `- qualityLedgerWrittenForFailedRowsRate: ${report.metrics.qualityLedgerWrittenForFailedRowsRate}`,
    `- unclassifiedQualityFailureCount: ${report.metrics.unclassifiedQualityFailureCount}`,
    `- operatorDashboardQualityLedgerCoverage: ${report.metrics.operatorDashboardQualityLedgerCoverage}`,
    `- parserChunkingQualityLedgerCoverage: ${report.metrics.parserChunkingQualityLedgerCoverage}`,
    `- temporalValidityLedgerCoverage: ${report.metrics.temporalValidityLedgerCoverage}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Query Rows",
    "",
    ...report.results.map(
      (row) =>
        `- ${row.id}: passed=${row.passed} residual=${row.residualOwner ?? "none"} evidence=${row.evidenceCount} sourceTrail=${row.sourceTrailCount} claimAudit=${row.claimAuditCount} missing=${row.missingTerms.join("|") || "-"}`
    ),
    "",
    "## Ledger Rows",
    "",
    ...report.ledgerRows.map((row) => `- ${row.ledgerId}: owner=${row.qualityOwner} source=${row.sourceKind} layer=${row.suggestedFixLayer}`),
    ""
  ].join("\n");
}

export async function runAndWriteIngestionQualityLedgerPack(): Promise<{
  readonly report: IngestionQualityLedgerPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `benchmark_ingestion_quality_ledger_${stamp.replace(/[^0-9A-Za-z]/gu, "_")}`;
  const failedRows = failedInputRows();
  const ledgerRows = ledgerRowsFromFailures(failedRows);
  await mkdir(outputDir(), { recursive: true });
  const ledgerJsonPath = path.join(outputDir(), `universal-ingestion-quality-ledger-${stamp}.json`);
  const ledgerMarkdownPath = path.join(outputDir(), `universal-ingestion-quality-ledger-${stamp}.md`);
  await writeFile(ledgerJsonPath, `${JSON.stringify({ generatedAt, benchmark: "universal_ingestion_quality_ledger", rows: ledgerRows }, null, 2)}\n`, "utf8");
  await writeFile(ledgerMarkdownPath, markdownForLedger(ledgerRows), "utf8");

  await ingestArtifact({
    namespaceId,
    inputUri: ledgerMarkdownPath,
    sourceType: "markdown",
    sourceChannel: "benchmark:ingestion_quality_ledger_pack",
    capturedAt: generatedAt,
    skipNarrativeClaims: true,
    skipExternalRelationCandidates: true,
    skipVectorActivation: true,
    metadata: {
      benchmark: "ingestion_quality_ledger_pack",
      source_kind_family: "ingestion_quality_ledger",
      ledger_json_path: ledgerJsonPath
    }
  });
  await rebuildTypedMemoryNamespace(namespaceId, { skipVectorActivation: true });

  const queryRows: QueryRow[] = [];
  for (const scenario of scenarios()) {
    queryRows.push(await runScenario(namespaceId, scenario));
  }

  const jsonPath = path.join(outputDir(), `ingestion-quality-ledger-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `ingestion-quality-ledger-pack-${stamp}.md`);
  const provisionalMetrics = ledgerMetrics(failedRows, ledgerRows, queryRows, false);
  const provisionalReport: IngestionQualityLedgerPackReport = {
    generatedAt,
    benchmark: "ingestion_quality_ledger_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        failedInputRows: failedRows.length,
        queryRows: queryRows.length,
        provisional: true
      }
    }),
    namespaceId,
    sampleCount: queryRows.length,
    passed: false,
    metrics: provisionalMetrics,
    ledgerArtifact: {
      jsonPath: ledgerJsonPath,
      markdownPath: ledgerMarkdownPath
    },
    operatorDashboardArtifact: null,
    ledgerRows,
    results: queryRows
  };
  await writeFile(jsonPath, `${JSON.stringify(provisionalReport, null, 2)}\n`, "utf8");

  const dashboard = await generateOperatorDashboard().catch(() => null);
  const operatorDashboardContainsLedger =
    dashboard?.artifacts.some((artifact) => artifact.prefix === "ingestion-quality-ledger-pack" && artifact.artifactPath !== null) === true;
  const computedMetrics = ledgerMetrics(failedRows, ledgerRows, queryRows, operatorDashboardContainsLedger);
  const report: IngestionQualityLedgerPackReport = {
    generatedAt,
    benchmark: "ingestion_quality_ledger_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId,
        failedInputRows: failedRows.length,
        queryRows: queryRows.length
      }
    }),
    namespaceId,
    sampleCount: queryRows.length,
    passed:
      queryRows.every((row) => row.passed) &&
      computedMetrics.qualityLedgerWrittenForFailedRowsRate === 1 &&
      computedMetrics.unclassifiedQualityFailureCount === 0 &&
      computedMetrics.operatorDashboardQualityLedgerCoverage === 1 &&
      computedMetrics.parserChunkingQualityLedgerCoverage === 1 &&
      computedMetrics.temporalValidityLedgerCoverage === 1 &&
      computedMetrics.taskCalendarQualityLedgerCoverage === 1 &&
      computedMetrics.sourceMissingLedgerCoverage === 1 &&
      computedMetrics.sourceTrailCoverageRate === 1 &&
      computedMetrics.claimAuditCoverageRate === 1 &&
      computedMetrics.supportedZeroEvidenceCount === 0 &&
      computedMetrics.supportedEmptySourceTrailCount === 0 &&
      computedMetrics.supportedMissingClaimAuditCount === 0 &&
      computedMetrics.queryTimeModelCalls === 0,
    metrics: computedMetrics,
    ledgerArtifact: {
      jsonPath: ledgerJsonPath,
      markdownPath: ledgerMarkdownPath
    },
    operatorDashboardArtifact: dashboard?.artifactPath ?? null,
    ledgerRows,
    results: queryRows
  };
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${markdownReport(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runIngestionQualityLedgerPackCli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteIngestionQualityLedgerPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}
