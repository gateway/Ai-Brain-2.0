import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import {
  parseAndSummarizeCodexSession,
  scanCodexSessions,
  type CodexSessionConfig,
  type CodexSummaryReport
} from "../codex-sessions/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface CodexSessionIngestionPhasePackReport {
  readonly generatedAt: string;
  readonly benchmark: "codex_session_ingestion_phase_0_4_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly fixture: {
    readonly codexHome: string;
    readonly sourcePath: string;
  };
  readonly metrics: {
    readonly sessionFileCount: number;
    readonly totalBytes: number;
    readonly dryRunMutationCount: number;
    readonly catalogRowsCreated: number;
    readonly rawFilesCopiedCount: number;
    readonly parsedEventCount: number;
    readonly malformedRowCount: number;
    readonly unknownEventShapeCount: number;
    readonly rawEventPreservationRate: number;
    readonly redactionHitCount: number;
    readonly secretLeakCount: number;
    readonly summarySchemaPassRate: number;
    readonly sourceEventRangeCoverageRate: number;
    readonly rawLogLeakCount: number;
    readonly memoryCandidateCount: number;
    readonly persistedEventCount: number;
    readonly persistedSummaryCount: number;
  };
  readonly summary: CodexSummaryReport["summary"];
  readonly failures: readonly string[];
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

function generatedRoot(): string {
  return path.resolve(outputDir(), "generated");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function writeJsonl(filePath: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`,
    "utf8"
  );
}

async function createFixture(): Promise<{ readonly config: CodexSessionConfig; readonly sourcePath: string }> {
  const root = path.join(generatedRoot(), `codex-session-ingestion-${stamp()}`);
  const codexHome = path.join(root, ".codex");
  const sessions = path.join(codexHome, "sessions", "2026", "05", "25");
  const archiveRoot = path.join(root, "ai-brain-archive");
  const sourcePath = path.join(sessions, "rollout-2026-05-25T07-00-00-019e-fixture-session.jsonl");
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-05-25T07:00:00.000Z",
      payload: {
        cwd: "/Users/example/projects/ai-brain",
        title: "Codex session ingestion implementation"
      }
    },
    {
      type: "user_message",
      timestamp: "2026-05-25T07:01:00.000Z",
      payload: {
        role: "user",
        text: "Implement Codex session ingestion. Do not embed raw transcripts. Make sure docs drift and tests are tracked."
      }
    },
    {
      type: "assistant_message",
      timestamp: "2026-05-25T07:02:00.000Z",
      payload: {
        role: "assistant",
        text: "Decision: raw Codex sessions stay archive-only while curated summaries become retrieval memory candidates."
      }
    },
    {
      type: "tool_call",
      timestamp: "2026-05-25T07:03:00.000Z",
      payload: {
        tool_name: "exec_command",
        command: "npm run build --workspace local-brain",
        cwd: "/Users/example/projects/ai-brain"
      }
    },
    {
      type: "tool_result",
      timestamp: "2026-05-25T07:04:00.000Z",
      payload: {
        stdout: "OPENAI_API_KEY=sk-fixturesecret12345678901234567890\nBuild passed for local-brain.",
        output: "Build passed."
      }
    },
    "{ malformed json row",
    {
      type: "assistant_message",
      timestamp: "2026-05-25T07:05:00.000Z",
      payload: {
        role: "assistant",
        text: "Implemented scanner, parser, redaction, and summary proof. Tests passed. Followup: add MCP retrieval packet in the next phase."
      }
    }
  ];
  await writeJsonl(sourcePath, rows);
  await writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: "019e-fixture-session", thread_name: "Codex ingestion fixture", updated_at: "2026-05-25T07:05:00.000Z" })}\n`,
    "utf8"
  );
  return {
    sourcePath,
    config: {
      codexHome,
      scanPaths: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
      excludePaths: [],
      sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
      stateSqlitePath: path.join(codexHome, "state_5.sqlite"),
      archiveRoot,
      archivePolicy: "archive_selected",
      namespaceId: `fixture_codex_ingestion_${stamp().toLowerCase()}`
    }
  };
}

function hasSecretLeak(summary: unknown): boolean {
  return /sk-fixturesecret|OPENAI_API_KEY=sk-/u.test(JSON.stringify(summary));
}

async function persistedCounts(namespaceId: string): Promise<{ readonly eventCount: number; readonly summaryCount: number }> {
  const eventRows = await queryRows<{ readonly total: string }>(
    "SELECT count(*)::text AS total FROM codex_session_events WHERE namespace_id = $1",
    [namespaceId]
  );
  const summaryRows = await queryRows<{ readonly total: string }>(
    "SELECT count(*)::text AS total FROM codex_session_summaries WHERE namespace_id = $1",
    [namespaceId]
  );
  return {
    eventCount: Number(eventRows[0]?.total ?? "0"),
    summaryCount: Number(summaryRows[0]?.total ?? "0")
  };
}

function toMarkdown(report: CodexSessionIngestionPhasePackReport): string {
  return [
    "# Codex Session Ingestion Phase 0-4 Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- sessionFileCount: ${report.metrics.sessionFileCount}`,
    `- dryRunMutationCount: ${report.metrics.dryRunMutationCount}`,
    `- catalogRowsCreated: ${report.metrics.catalogRowsCreated}`,
    `- rawFilesCopiedCount: ${report.metrics.rawFilesCopiedCount}`,
    `- parsedEventCount: ${report.metrics.parsedEventCount}`,
    `- malformedRowCount: ${report.metrics.malformedRowCount}`,
    `- redactionHitCount: ${report.metrics.redactionHitCount}`,
    `- secretLeakCount: ${report.metrics.secretLeakCount}`,
    `- summarySchemaPassRate: ${report.metrics.summarySchemaPassRate}`,
    `- memoryCandidateCount: ${report.metrics.memoryCandidateCount}`,
    "",
    "## Summary Example",
    "",
    `- title: ${report.summary.session_title}`,
    `- status: ${report.summary.status}`,
    `- domain: ${report.summary.domain}`,
    `- intent: ${report.summary.human_intent}`,
    `- implementation: ${report.summary.implementation_summary}`,
    "",
    "## Failures",
    "",
    report.failures.length === 0 ? "- none" : report.failures.map((failure) => `- ${failure}`).join("\n"),
    ""
  ].join("\n");
}

export async function runCodexSessionIngestionPhase04Pack(): Promise<{
  readonly report: CodexSessionIngestionPhasePackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const fixture = await createFixture();
  const dryRun = await scanCodexSessions(fixture.config, { dryRun: true, archivePolicy: "archive_selected" });
  const persistedScan = await scanCodexSessions(fixture.config, { dryRun: false, archivePolicy: "archive_selected" });
  const parsed = await parseAndSummarizeCodexSession({
    namespaceId: fixture.config.namespaceId,
    sourcePath: fixture.sourcePath,
    persist: true
  });
  const counts = await persistedCounts(fixture.config.namespaceId);
  const secretLeakCount = hasSecretLeak(parsed.summary.summary) ? 1 : 0;
  const metrics = {
    sessionFileCount: dryRun.metrics.sessionFileCount,
    totalBytes: dryRun.metrics.totalBytes,
    dryRunMutationCount: dryRun.metrics.dryRunMutationCount,
    catalogRowsCreated: persistedScan.metrics.catalogRowsCreated,
    rawFilesCopiedCount: persistedScan.metrics.rawFilesCopiedCount,
    parsedEventCount: parsed.parse.metrics.parsedEventCount,
    malformedRowCount: parsed.parse.metrics.malformedRowCount,
    unknownEventShapeCount: parsed.parse.metrics.unknownEventShapeCount,
    rawEventPreservationRate: parsed.parse.metrics.rawEventPreservationRate,
    redactionHitCount: parsed.parse.metrics.redactionHitCount,
    secretLeakCount,
    summarySchemaPassRate: parsed.summary.metrics.summarySchemaPassRate,
    sourceEventRangeCoverageRate: parsed.summary.metrics.sourceEventRangeCoverageRate,
    rawLogLeakCount: parsed.summary.metrics.rawLogLeakCount,
    memoryCandidateCount: parsed.summary.summary.memory_candidates.length,
    persistedEventCount: counts.eventCount,
    persistedSummaryCount: counts.summaryCount
  };
  const failures = [
    metrics.sessionFileCount < 1 ? "session_file_not_discovered" : "",
    metrics.dryRunMutationCount !== 0 ? "dry_run_mutated_state" : "",
    metrics.catalogRowsCreated !== 1 ? "catalog_row_not_created" : "",
    metrics.rawFilesCopiedCount !== 1 ? "raw_file_not_archived" : "",
    metrics.parsedEventCount < 6 ? "events_not_parsed" : "",
    metrics.malformedRowCount !== 1 ? "malformed_row_not_tracked" : "",
    metrics.redactionHitCount < 1 ? "secret_redaction_not_detected" : "",
    metrics.secretLeakCount !== 0 ? "secret_leaked_to_summary" : "",
    metrics.summarySchemaPassRate !== 1 ? "summary_schema_failed" : "",
    metrics.sourceEventRangeCoverageRate !== 1 ? "summary_source_range_missing" : "",
    metrics.rawLogLeakCount !== 0 ? "raw_log_leaked_to_summary" : "",
    metrics.memoryCandidateCount < 3 ? "insufficient_memory_candidates" : "",
    metrics.persistedEventCount < 6 ? "events_not_persisted" : "",
    metrics.persistedSummaryCount < 1 ? "summary_not_persisted" : ""
  ].filter(Boolean);
  const report: CodexSessionIngestionPhasePackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_session_ingestion_phase_0_4_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: {
        namespaceId: fixture.config.namespaceId
      }
    }),
    passed: failures.length === 0,
    fixture: {
      codexHome: fixture.config.codexHome,
      sourcePath: fixture.sourcePath
    },
    metrics,
    summary: parsed.summary.summary,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const generatedAt = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `codex-session-ingestion-phase-0-4-pack-${generatedAt}.json`);
  const markdownPath = path.join(dir, `codex-session-ingestion-phase-0-4-pack-${generatedAt}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexSessionIngestionPhase04PackCli(): Promise<void> {
  const { report, output } = await runCodexSessionIngestionPhase04Pack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
