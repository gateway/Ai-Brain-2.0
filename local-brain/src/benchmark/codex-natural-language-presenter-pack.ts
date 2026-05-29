import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";
import { executeMcpTool } from "../mcp/server.js";
import { buildBenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import { runCodexSessionPhase57Pack } from "./codex-session-phase-5-7-pack.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

const SCENARIOS = [
  {
    id: "stack_standards_compact",
    query: "What stack and standards usually apply to this repo?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["Postgres", "source"]
  },
  {
    id: "mistakes_compact",
    query: "What mistakes should Codex avoid on this repo?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["avoid"]
  },
  {
    id: "skills_compact",
    query: "What skill candidates came from my Codex sessions?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["skill"]
  },
  {
    id: "project_patterns_without_codex_compact",
    query: "What repeated patterns show up in AI Brain?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["Postgres", "source"]
  },
  {
    id: "project_instructions_without_codex_compact",
    query: "What repeated instructions came up in the operator workbench?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["Postgres", "source"]
  },
  {
    id: "token_waste_compact",
    query: "What token waste patterns show up in Codex sessions?",
    expectedContract: "workflow_pattern_report",
    expectedTerms: ["token"]
  },
  {
    id: "packet_compact",
    query: "Generate an agent memory packet for this task.",
    expectedContract: "engineering_memory_packet",
    expectedTerms: ["curated summaries", "source"]
  }
] as const;

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function answerText(payload: any): string {
  return String(payload?.humanReadable?.answer ?? payload?.answer ?? payload?.duality?.claim?.text ?? "").replace(/\s+/gu, " ").trim();
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function looksLikeEvidenceSnippet(answer: string): boolean {
  return /^(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation)\b/iu.test(answer);
}

function hasOperatingContextLeak(text: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count/iu.test(text);
}

async function runScenario(namespaceId: string, scenario: (typeof SCENARIOS)[number]): Promise<Record<string, unknown>> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "compact",
    limit: 10
  })) as { readonly structuredContent?: any };
  const fullWrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.query,
    detail_mode: "full",
    limit: 10
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const fullPayload = fullWrapped.structuredContent ?? {};
  const answer = answerText(payload);
  const fullAnswer = answerText(fullPayload);
  const allText = JSON.stringify(payload);
  const missingTerms = scenario.expectedTerms.filter((term) => !allText.toLowerCase().includes(term.toLowerCase()));
  const actualContract = typeof payload?.queryContract === "string" ? payload.queryContract : typeof payload?.meta?.queryContractName === "string" ? payload.meta.queryContractName : null;
  const evidenceCount = payloadEvidenceCount(payload);
  const row = {
    id: scenario.id,
    query: scenario.query,
    actualContract,
    expectedContract: scenario.expectedContract,
    finalClaimSource: payload?.finalClaimSource ?? payload?.meta?.finalClaimSource ?? null,
    selectedReader: payload?.meta?.selectedReader ?? null,
    evidenceCount,
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    fullSourceTrailCount: sourceTrailCount(fullPayload),
    fullClaimAuditCount: claimAuditCount(fullPayload),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    fullQueryTimeModelCalls: queryTimeModelCallsFromPayload(fullPayload),
    answer,
    fullAnswer: fullAnswer.slice(0, 1200),
    answerLength: answer.length,
    fullAnswerLength: fullAnswer.length,
    snippetLike: looksLikeEvidenceSnippet(answer),
    operatingContextLeak: hasOperatingContextLeak(allText),
    missingTerms
  };
  return {
    ...row,
    passed:
      actualContract === scenario.expectedContract &&
      evidenceCount > 0 &&
      sourceTrailCount(payload) > 0 &&
      claimAuditCount(payload) > 0 &&
      sourceTrailCount(fullPayload) > 0 &&
      claimAuditCount(fullPayload) > 0 &&
      queryTimeModelCallsFromPayload(payload) === 0 &&
      queryTimeModelCallsFromPayload(fullPayload) === 0 &&
      answer.length >= 40 &&
      fullAnswer.length >= answer.length &&
      !looksLikeEvidenceSnippet(answer) &&
      !hasOperatingContextLeak(allText) &&
      missingTerms.length === 0
  };
}

export async function runCodexNaturalLanguagePresenterPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const phase57 = await runCodexSessionPhase57Pack("retrieval");
  const namespaceId = phase57.report.namespaceId as string;
  const projection = await projectCodexSessionSpecCoverage({ namespaceId });
  const rows = await Promise.all(SCENARIOS.map((scenario) => runScenario(namespaceId, scenario)));
  const metrics = {
    queryCount: rows.length,
    strongCount: rows.filter((row) => row.passed === true).length,
    snippetLikeAnswerCount: rows.filter((row) => row.snippetLike === true).length,
    operatingContextLeakCount: rows.filter((row) => row.operatingContextLeak === true).length,
    supportedZeroEvidenceRows: rows.filter((row) => Number(row.evidenceCount) === 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => Number(row.sourceTrailCount) === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => Number(row.claimAuditCount) === 0).length,
    fullEmptySourceTrailRows: rows.filter((row) => Number(row.fullSourceTrailCount) === 0).length,
    fullMissingClaimAuditRows: rows.filter((row) => Number(row.fullClaimAuditCount) === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + Number(row.queryTimeModelCalls ?? 0) + Number(row.fullQueryTimeModelCalls ?? 0), 0),
    rawTranscriptEmbeddingCount: projection.rawTranscriptEmbeddingCount,
    rawTranscriptRetrievalCount: projection.rawTranscriptRetrievalCount
  };
  const failures = [
    metrics.strongCount !== metrics.queryCount ? "codex_presenter_query_quality_below_gate" : "",
    metrics.snippetLikeAnswerCount !== 0 ? "snippet_like_answers" : "",
    metrics.operatingContextLeakCount !== 0 ? "operating_context_leak" : "",
    metrics.supportedZeroEvidenceRows !== 0 ? "supported_zero_evidence" : "",
    metrics.supportedEmptySourceTrailRows !== 0 ? "empty_source_trail" : "",
    metrics.supportedMissingClaimAuditRows !== 0 ? "missing_claim_audit" : "",
    metrics.fullEmptySourceTrailRows !== 0 ? "full_empty_source_trail" : "",
    metrics.fullMissingClaimAuditRows !== 0 ? "full_missing_claim_audit" : "",
    metrics.queryTimeModelCalls !== 0 ? "query_time_model_calls_detected" : "",
    metrics.rawTranscriptEmbeddingCount !== 0 ? "raw_transcript_embedding_detected" : "",
    metrics.rawTranscriptRetrievalCount !== 0 ? "raw_transcript_retrieval_detected" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "codex_natural_language_presenter_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "full",
      sampleControls: { namespaceId }
    }),
    namespaceId,
    phase57Artifact: phase57.output.jsonPath,
    projection,
    rows,
    metrics,
    passed: failures.length === 0,
    failures
  };
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const suffix = stamp();
  const base = `codex-natural-language-presenter-pack-${suffix}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    markdownPath,
    [
      "# Codex Natural Language Presenter Pack",
      "",
      `- passed: ${report.passed}`,
      `- strongCount: ${metrics.strongCount}/${metrics.queryCount}`,
      `- snippetLikeAnswerCount: ${metrics.snippetLikeAnswerCount}`,
      `- operatingContextLeakCount: ${metrics.operatingContextLeakCount}`,
      `- fullEmptySourceTrailRows: ${metrics.fullEmptySourceTrailRows}`,
      `- fullMissingClaimAuditRows: ${metrics.fullMissingClaimAuditRows}`,
      `- queryTimeModelCalls: ${metrics.queryTimeModelCalls}`,
      "",
      "## Answers",
      ...rows.map((row: any) => `- ${row.id}: ${row.passed ? "strong" : `weak missing=${row.missingTerms.join(", ")}`} -> ${row.answer}`)
    ].join("\n") + "\n",
    "utf8"
  );
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCodexNaturalLanguagePresenterPackCli(): Promise<void> {
  try {
    const { report, output } = await runCodexNaturalLanguagePresenterPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
    process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      throw new Error(`codex-natural-language-presenter-pack failed: ${report.failures.join(", ")}`);
    }
  } finally {
    await closePool();
  }
}
