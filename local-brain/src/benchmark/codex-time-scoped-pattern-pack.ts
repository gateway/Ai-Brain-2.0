import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

interface TimeScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly referenceNow: string;
  readonly expectedSupport: "supported" | "abstained";
  readonly expectedTerms: readonly string[];
}

const SCENARIOS: readonly TimeScenario[] = [
  {
    id: "media_this_week_supported",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What repeated patterns show up in Media Studio this week?",
    referenceNow: "2026-05-27T00:00:00.000Z",
    expectedSupport: "supported",
    expectedTerms: ["Media Studio"]
  },
  {
    id: "media_last_week_abstains",
    namespaceId: "codex_media_studio_backfill_20260526_01",
    query: "What mistakes commonly came up last week in the media studio?",
    referenceNow: "2026-05-27T00:00:00.000Z",
    expectedSupport: "abstained",
    expectedTerms: []
  },
  {
    id: "ai_brain_this_week_supported",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What repeated patterns show up in AI Brain this week?",
    referenceNow: "2026-05-27T00:00:00.000Z",
    expectedSupport: "supported",
    expectedTerms: ["raw transcripts", "curated"]
  },
  {
    id: "ai_brain_last_week_abstains",
    namespaceId: "codex_ai_brain_backfill_20260526_01",
    query: "What token waste patterns showed up in AI Brain last week?",
    referenceNow: "2026-05-27T00:00:00.000Z",
    expectedSupport: "abstained",
    expectedTerms: []
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function text(payload: any): string {
  return JSON.stringify(payload ?? null).toLowerCase();
}

function answer(payload: any): string {
  return String(payload?.humanReadable?.answer ?? payload?.answer ?? payload?.duality?.claim?.text ?? "").replace(/\s+/gu, " ").trim();
}

async function runScenario(scenario: TimeScenario): Promise<Record<string, unknown>> {
  const started = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    reference_now: scenario.referenceNow,
    detail_mode: "compact",
    limit: 8
  })) as { readonly structuredContent?: any };
  const latencyMs = Number((performance.now() - started).toFixed(2));
  const payload = wrapped.structuredContent ?? {};
  const evidenceCount = payloadEvidenceCount(payload);
  const sourceCount = sourceTrailCount(payload);
  const auditCount = claimAuditCount(payload);
  const finalClaimSource = payload?.finalClaimSource ?? payload?.meta?.finalClaimSource ?? null;
  const missingTerms = scenario.expectedTerms.filter((term) => !text(payload).includes(term.toLowerCase()));
  const supportedPass =
    scenario.expectedSupport === "supported" &&
    evidenceCount > 0 &&
    sourceCount > 0 &&
    auditCount > 0 &&
    missingTerms.length === 0;
  const abstainPass =
    scenario.expectedSupport === "abstained" &&
    evidenceCount === 0 &&
    (finalClaimSource === "codex_memory_abstention" || finalClaimSource === "abstention");
  const wrongTimeWindowLeak = scenario.expectedSupport === "abstained" && evidenceCount > 0;
  return {
    ...scenario,
    finalClaimSource,
    selectedReader: payload?.meta?.selectedReader ?? null,
    queryContract: payload?.queryContract ?? payload?.meta?.queryContractName ?? null,
    evidenceCount,
    sourceTrailCount: sourceCount,
    claimAuditCount: auditCount,
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    rawTranscriptRetrievalCount: Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0),
    missingTerms,
    wrongTimeWindowLeak,
    latencyMs,
    answer: answer(payload).slice(0, 900),
    passed: (supportedPass || abstainPass) && queryTimeModelCallsFromPayload(payload) === 0 && Number(payload?.meta?.rawTranscriptRetrievalCount ?? 0) === 0
  };
}

export async function runCodexTimeScopedPatternPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = await Promise.all(SCENARIOS.map(runScenario));
  const metrics = {
    queryCount: rows.length,
    strongCount: rows.filter((row) => row.passed === true).length,
    strongRate: rate(rows.filter((row) => row.passed === true).length, rows.length),
    wrongTimeWindowLeakCount: rows.filter((row) => row.wrongTimeWindowLeak === true).length,
    supportedZeroEvidenceCount: rows.filter((row) => row.expectedSupport === "supported" && Number(row.evidenceCount) === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0), 0),
    rawTranscriptRetrievalCount: rows.reduce((sum, row) => sum + Number(row.rawTranscriptRetrievalCount ?? 0), 0)
  };
  const failures = [
    metrics.strongCount !== metrics.queryCount ? "time_scoped_query_quality_below_gate" : "",
    metrics.wrongTimeWindowLeakCount !== 0 ? "wrong_time_window_leak" : "",
    metrics.supportedZeroEvidenceCount !== 0 ? "supported_zero_evidence" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_time_scoped_pattern_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { referenceNow: "2026-05-27T00:00:00.000Z" }
    }),
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const base = `codex-time-scoped-pattern-pack-${stamp()}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Time-Scoped Pattern Pack",
      "",
      `- passed: ${report.passed}`,
      `- strongCount: ${metrics.strongCount}/${metrics.queryCount}`,
      `- wrongTimeWindowLeakCount: ${metrics.wrongTimeWindowLeakCount}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      `- rawTranscriptRetrievalCount: ${metrics.rawTranscriptRetrievalCount}`,
      "",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : "weak"} -> ${row.answer}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexTimeScopedPatternPackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexTimeScopedPatternPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-time-scoped-pattern-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
