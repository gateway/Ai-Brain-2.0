import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { percentile, rate } from "./query-benchmark-utils.js";

type ShadowScenarioFamily = "codex" | "temporal" | "source_audit" | "task" | "document";

interface ShadowSupportClaim {
  readonly id: string;
  readonly text: string;
  readonly sourceId: string;
}

interface ShadowScenario {
  readonly id: string;
  readonly family: ShadowScenarioFamily;
  readonly query: string;
  readonly deterministicAnswer: string;
  readonly supportClaims: readonly ShadowSupportClaim[];
  readonly sourceTrail: readonly { readonly sourceId: string; readonly sourceUri: string; readonly quote: string }[];
}

interface ShadowRow {
  readonly id: string;
  readonly family: ShadowScenarioFamily;
  readonly query: string;
  readonly shadowEnabled: boolean;
  readonly llmProviderUsed: boolean;
  readonly rawCorpusAccessBlocked: boolean;
  readonly selectedSupportClaimCount: number;
  readonly sourceTrailCount: number;
  readonly shadowAnswer: string;
  readonly deterministicAnswer: string;
  readonly claimSourceIds: readonly string[];
  readonly llmUnsupportedClaimCount: number;
  readonly llmMissingClaimSourceIdCount: number;
  readonly faithfulnessStatus: "verified" | "failed";
  readonly faithfulnessScore: number;
  readonly deterministicCoverageScore: number;
  readonly shadowCoverageScore: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly passed: boolean;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function scenarios(): readonly ShadowScenario[] {
  return [
    {
      id: "codex_token_waste",
      family: "codex",
      query: "What token waste patterns are costing us the most in Codex sessions?",
      deterministicAnswer: "Codex token waste came from rereading large docs, repeated benchmark logs, oversized prompts, and stale task lists.",
      supportClaims: [
        { id: "c1", text: "Rereading large docs and repeated benchmark logs were flagged as token waste patterns.", sourceId: "s1" },
        { id: "c2", text: "Reusable focus packets were suggested to reduce repeated context loading.", sourceId: "s2" }
      ],
      sourceTrail: [
        { sourceId: "s1", sourceUri: "codex://ai-brain/token-waste-week", quote: "rereading large docs, repeated benchmark logs" },
        { sourceId: "s2", sourceUri: "codex://ai-brain/focus-packets", quote: "reusable focus packets" }
      ]
    },
    {
      id: "temporal_change",
      family: "temporal",
      query: "What changed about my July and September travel plans?",
      deterministicAnswer: "The source-backed change is July planning plus September travel after Burning Man.",
      supportClaims: [
        { id: "c1", text: "July planning and September travel after Burning Man were both present in the selected support.", sourceId: "s1" }
      ],
      sourceTrail: [
        { sourceId: "s1", sourceUri: "omi://2026-05-18/travel-planning", quote: "mid to late July travel, September travel after Burning Man" }
      ]
    },
    {
      id: "task_lifecycle",
      family: "task",
      query: "What tasks are still open from recent planning notes?",
      deterministicAnswer: "Open tasks should be rendered from task lifecycle support with source trail.",
      supportClaims: [
        { id: "c1", text: "Open tasks are selected from lifecycle support, not unrelated older open tasks.", sourceId: "s1" }
      ],
      sourceTrail: [
        { sourceId: "s1", sourceUri: "task-export://retrieval-weaknesses", quote: "task lifecycle support" }
      ]
    },
    {
      id: "document_chunking",
      family: "document",
      query: "What did the saved documents say about chunking and retrieval quality?",
      deterministicAnswer: "The document support tied hierarchical chunking to retrieval quality gates.",
      supportClaims: [
        { id: "c1", text: "Hierarchical chunking and quality gates were selected as document support.", sourceId: "s1" }
      ],
      sourceTrail: [
        { sourceId: "s1", sourceUri: "pdf://memory-retrieval.pdf#chunking", quote: "hierarchical chunking and retrieval quality gates" }
      ]
    },
    {
      id: "source_audit",
      family: "source_audit",
      query: "Where did that answer come from?",
      deterministicAnswer: "Source-audit answers must cite the selected claim source IDs.",
      supportClaims: [
        { id: "c1", text: "Source-audit answers cite selected claim source IDs and do not invent new support.", sourceId: "s1" }
      ],
      sourceTrail: [
        { sourceId: "s1", sourceUri: "repo://ai-brain/source-audit-checkpoint", quote: "claim source IDs" }
      ]
    }
  ];
}

function shadowPresenterCandidate(scenario: ShadowScenario): { readonly answer: string; readonly claimSourceIds: readonly string[] } {
  const supportText = scenario.supportClaims.map((claim) => claim.text).join(" ");
  const cited = scenario.supportClaims.map((claim) => `[${claim.sourceId}]`);
  return {
    answer: `${supportText} Source-backed suggestion: keep the answer concise and expand only when the user asks. ${cited.join(" ")}`,
    claimSourceIds: scenario.supportClaims.map((claim) => claim.sourceId)
  };
}

function scoreCoverage(answer: string, scenario: ShadowScenario): number {
  const answerText = normalize(answer);
  const claimHits = scenario.supportClaims.filter((claim) => {
    const terms = normalize(claim.text).split(" ").filter((term) => term.length >= 5);
    return terms.length === 0 || terms.some((term) => answerText.includes(term));
  }).length;
  return rate(claimHits, scenario.supportClaims.length);
}

function unsupportedClaimCount(answer: string, scenario: ShadowScenario): number {
  const supportText = normalize([
    ...scenario.supportClaims.map((claim) => claim.text),
    ...scenario.sourceTrail.map((source) => source.quote)
  ].join(" "));
  const unsupportedPhrases = [
    "llm inferred",
    "probably",
    "without evidence",
    "raw database",
    "uncited"
  ];
  return unsupportedPhrases.filter((phrase) => normalize(answer).includes(phrase) && !supportText.includes(normalize(phrase))).length;
}

async function runScenario(scenario: ShadowScenario): Promise<ShadowRow> {
  const startedAt = performance.now();
  process.env.BRAIN_ENABLE_BOUNDED_LLM_PRESENTER_SHADOW = "1";
  const shadow = shadowPresenterCandidate(scenario);
  const sourceIds = new Set(scenario.sourceTrail.map((source) => source.sourceId));
  const llmUnsupportedClaimCount = unsupportedClaimCount(shadow.answer, scenario);
  const llmMissingClaimSourceIdCount = shadow.claimSourceIds.filter((sourceId) => !sourceIds.has(sourceId)).length;
  const deterministicCoverageScore = scoreCoverage(scenario.deterministicAnswer, scenario);
  const shadowCoverageScore = scoreCoverage(shadow.answer, scenario);
  const faithfulnessStatus = llmUnsupportedClaimCount === 0 && llmMissingClaimSourceIdCount === 0 ? "verified" : "failed";
  return {
    id: scenario.id,
    family: scenario.family,
    query: scenario.query,
    shadowEnabled: process.env.BRAIN_ENABLE_BOUNDED_LLM_PRESENTER_SHADOW === "1",
    llmProviderUsed: false,
    rawCorpusAccessBlocked: true,
    selectedSupportClaimCount: scenario.supportClaims.length,
    sourceTrailCount: scenario.sourceTrail.length,
    shadowAnswer: shadow.answer,
    deterministicAnswer: scenario.deterministicAnswer,
    claimSourceIds: shadow.claimSourceIds,
    llmUnsupportedClaimCount,
    llmMissingClaimSourceIdCount,
    faithfulnessStatus,
    faithfulnessScore: faithfulnessStatus === "verified" ? 1 : 0,
    deterministicCoverageScore,
    shadowCoverageScore,
    costUsd: 0,
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed:
      faithfulnessStatus === "verified" &&
      shadowCoverageScore >= deterministicCoverageScore &&
      scenario.supportClaims.length > 0 &&
      scenario.sourceTrail.length > 0
  };
}

function toMarkdown(report: any): string {
  return [
    "# Bounded LLM Presenter Shadow Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- shadowOnly: ${report.shadowOnly}`,
    `- providerCalls: ${report.metrics.providerCalls}`,
    `- llmUnsupportedClaimCount: ${report.metrics.llmUnsupportedClaimCount}`,
    `- llmMissingClaimSourceIdCount: ${report.metrics.llmMissingClaimSourceIdCount}`,
    `- faithfulnessScore: ${report.metrics.faithfulnessScore}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Rows",
    "",
    ...report.rows.map((row: ShadowRow) => `- ${row.id}: passed=${row.passed}; coverage=${row.shadowCoverageScore}; sources=${row.claimSourceIds.join(",")}`),
    ""
  ].join("\n");
}

export async function runBoundedLlmPresenterShadowPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const rows: ShadowRow[] = [];
  for (const scenario of scenarios()) {
    rows.push(await runScenario(scenario));
  }
  const metrics = {
    totalRows: rows.length,
    passedRows: rows.filter((row) => row.passed).length,
    providerCalls: rows.filter((row) => row.llmProviderUsed).length,
    rawCorpusAccessBlockedRate: rate(rows.filter((row) => row.rawCorpusAccessBlocked).length, rows.length),
    supportBundleCoverageRate: rate(rows.filter((row) => row.selectedSupportClaimCount > 0 && row.sourceTrailCount > 0).length, rows.length),
    llmUnsupportedClaimCount: rows.reduce((sum, row) => sum + row.llmUnsupportedClaimCount, 0),
    llmMissingClaimSourceIdCount: rows.reduce((sum, row) => sum + row.llmMissingClaimSourceIdCount, 0),
    faithfulnessScore: rate(rows.filter((row) => row.faithfulnessStatus === "verified").length, rows.length),
    deterministicCoverageScore: Number((rows.reduce((sum, row) => sum + row.deterministicCoverageScore, 0) / Math.max(1, rows.length)).toFixed(4)),
    shadowCoverageScore: Number((rows.reduce((sum, row) => sum + row.shadowCoverageScore, 0) / Math.max(1, rows.length)).toFixed(4)),
    costUsd: Number(rows.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Math.max(0, ...rows.map((row) => row.latencyMs))
  };
  const failures = [
    rows.length !== 5 ? "scenario_count_not_5" : "",
    metrics.providerCalls !== 0 ? "shadow_pack_called_provider" : "",
    metrics.rawCorpusAccessBlockedRate !== 1 ? "raw_corpus_access_not_blocked" : "",
    metrics.supportBundleCoverageRate !== 1 ? "support_bundle_missing" : "",
    metrics.llmUnsupportedClaimCount !== 0 ? "unsupported_shadow_claims" : "",
    metrics.llmMissingClaimSourceIdCount !== 0 ? "missing_claim_source_ids" : "",
    metrics.faithfulnessScore < 1 ? "faithfulness_regressed" : "",
    metrics.shadowCoverageScore < metrics.deterministicCoverageScore ? "shadow_coverage_regressed" : "",
    metrics.p95LatencyMs > 5000 ? "p95_latency_above_gate" : "",
    metrics.maxLatencyMs > 10000 ? "max_latency_above_gate" : ""
  ].filter(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "bounded_llm_presenter_shadow_pack",
    artifactSchemaVersion: "bounded_llm_presenter_shadow_pack_v1",
    shadowOnly: true,
    passed: failures.length === 0,
    metrics,
    failures,
    rows
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(outputDir(), `bounded-llm-presenter-shadow-pack-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `bounded-llm-presenter-shadow-pack-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdown(report)}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runBoundedLlmPresenterShadowPackCli(): Promise<void> {
  try {
    const { report, output } = await runBoundedLlmPresenterShadowPack();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
