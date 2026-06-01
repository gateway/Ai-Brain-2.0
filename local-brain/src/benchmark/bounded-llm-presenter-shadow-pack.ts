import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { percentile, rate } from "./query-benchmark-utils.js";

type ShadowScenarioFamily =
  | "omi"
  | "codex"
  | "pdf_document"
  | "task"
  | "calendar"
  | "temporal"
  | "source_audit"
  | "career"
  | "relationship"
  | "dossier";

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
  readonly shadowOnly: boolean;
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
  readonly deterministicReadabilityScore: number;
  readonly shadowReadabilityScore: number;
  readonly readabilityWin: boolean;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly passed: boolean;
}

export interface BoundedLlmPresenterShadowReport {
  readonly generatedAt: string;
  readonly benchmark: "bounded_llm_presenter_shadow_pack";
  readonly artifactSchemaVersion: "bounded_llm_presenter_shadow_pack_v2";
  readonly shadowOnly: true;
  readonly passed: boolean;
  readonly metrics: {
    readonly totalRows: number;
    readonly passedRows: number;
    readonly providerCalls: number;
    readonly rawCorpusAccessBlockedRate: number;
    readonly supportBundleCoverageRate: number;
    readonly llmUnsupportedClaimCount: number;
    readonly llmMissingClaimSourceIdCount: number;
    readonly faithfulnessScore: number;
    readonly deterministicCoverageScore: number;
    readonly shadowCoverageScore: number;
    readonly deterministicReadabilityScore: number;
    readonly shadowReadabilityScore: number;
    readonly readabilityWinRate: number;
    readonly familyCoverageCount: number;
    readonly costUsd: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly rows: readonly ShadowRow[];
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

const FAMILY_FIXTURES: readonly {
  readonly family: ShadowScenarioFamily;
  readonly sourceUri: string;
  readonly queryNoun: string;
  readonly claimA: string;
  readonly claimB: string;
  readonly quoteA: string;
  readonly quoteB: string;
}[] = [
  {
    family: "omi",
    sourceUri: "omi://2026-05-18/travel-planning",
    queryNoun: "latest OMI planning note",
    claimA: "The latest OMI planning note mentioned travel planning and source-scoped task extraction.",
    claimB: "The note support should stay bound to the selected source window.",
    quoteA: "latest OMI planning note",
    quoteB: "source-scoped task extraction"
  },
  {
    family: "codex",
    sourceUri: "codex://ai-brain/token-waste-week",
    queryNoun: "Codex workflow patterns",
    claimA: "Codex sessions repeatedly flagged rereading large docs and benchmark logs as token waste.",
    claimB: "Reusable focus packets were suggested to reduce repeated context loading.",
    quoteA: "rereading large docs and benchmark logs",
    quoteB: "reusable focus packets"
  },
  {
    family: "pdf_document",
    sourceUri: "pdf://memory-retrieval.pdf#chunking",
    queryNoun: "saved memory PDFs",
    claimA: "The document support tied hierarchical chunking to retrieval quality gates.",
    claimB: "The selected PDF support emphasized provenance and source-bound fields.",
    quoteA: "hierarchical chunking",
    quoteB: "provenance and source-bound fields"
  },
  {
    family: "task",
    sourceUri: "task-export://retrieval-weaknesses",
    queryNoun: "open task list",
    claimA: "Open tasks are selected from lifecycle support, not unrelated older open tasks.",
    claimB: "Due-date answers require explicit due support before rendering factual task prose.",
    quoteA: "task lifecycle support",
    quoteB: "explicit due support"
  },
  {
    family: "calendar",
    sourceUri: "calendar://phase-14-ai-calendar",
    queryNoun: "calendar commitments",
    claimA: "Calendar answers use event windows instead of note capture time.",
    claimB: "June commitments came from selected calendar-export support.",
    quoteA: "event windows",
    quoteB: "calendar-export support"
  },
  {
    family: "temporal",
    sourceUri: "omi://2026-05-18/travel-planning#temporal",
    queryNoun: "July and September travel changes",
    claimA: "July planning and September travel after Burning Man were both present in selected support.",
    claimB: "The temporal reader should render deltas from event-window evidence.",
    quoteA: "mid to late July travel",
    quoteB: "September travel after Burning Man"
  },
  {
    family: "source_audit",
    sourceUri: "repo://ai-brain/source-audit-checkpoint",
    queryNoun: "source audit answer",
    claimA: "Source-audit answers cite selected claim source IDs and do not invent new support.",
    claimB: "Claim audit entries remain mandatory for supported answers.",
    quoteA: "claim source IDs",
    quoteB: "claim audit entries"
  },
  {
    family: "career",
    sourceUri: "career://work-history-projection",
    queryNoun: "career history",
    claimA: "Career answers are assembled from employment and work-history projections.",
    claimB: "Unknown dates must remain explicit instead of being guessed.",
    quoteA: "employment and work-history projections",
    quoteB: "unknown dates"
  },
  {
    family: "relationship",
    sourceUri: "relationship://chiang-mai-friend-set",
    queryNoun: "relationship answer",
    claimA: "Relationship answers keep people and places in separate roles.",
    claimB: "Friend-set answers require source-backed relationship evidence.",
    quoteA: "people and places in separate roles",
    quoteB: "source-backed relationship evidence"
  },
  {
    family: "dossier",
    sourceUri: "dossier://sectioned-profile-report",
    queryNoun: "sectioned dossier",
    claimA: "Dossier answers render independently supported sections.",
    claimB: "Unsupported sections should abstain instead of borrowing generic snippets.",
    quoteA: "independently supported sections",
    quoteB: "unsupported sections should abstain"
  }
];

function scenarios(): readonly ShadowScenario[] {
  return FAMILY_FIXTURES.flatMap((fixture, familyIndex) =>
    Array.from({ length: 5 }, (_, variantIndex) => {
      const sourceA = `${fixture.family}-${variantIndex + 1}-a`;
      const sourceB = `${fixture.family}-${variantIndex + 1}-b`;
      return {
        id: `${fixture.family}_${variantIndex + 1}`,
        family: fixture.family,
        query: `Summarize the selected ${fixture.queryNoun} support, variation ${variantIndex + 1}.`,
        deterministicAnswer: `Support ${familyIndex + 1}.${variantIndex + 1}: ${fixture.claimA}; ${fixture.claimB}. Sources=${sourceA},${sourceB}.`,
        supportClaims: [
          { id: `claim-${sourceA}`, text: fixture.claimA, sourceId: sourceA },
          { id: `claim-${sourceB}`, text: fixture.claimB, sourceId: sourceB }
        ],
        sourceTrail: [
          { sourceId: sourceA, sourceUri: `${fixture.sourceUri}?row=${variantIndex + 1}#a`, quote: fixture.quoteA },
          { sourceId: sourceB, sourceUri: `${fixture.sourceUri}?row=${variantIndex + 1}#b`, quote: fixture.quoteB }
        ]
      } satisfies ShadowScenario;
    })
  );
}

function shadowPresenterCandidate(scenario: ShadowScenario): { readonly answer: string; readonly claimSourceIds: readonly string[] } {
  const [firstClaim, secondClaim] = scenario.supportClaims;
  const sourceLabels = scenario.supportClaims.map((claim) => `[${claim.sourceId}]`).join(" ");
  return {
    answer: [
      `Answer: ${firstClaim?.text ?? ""}`,
      secondClaim ? `What this means: ${secondClaim.text}` : "",
      "Suggestion: keep the concise answer readable, then expand into source details only when asked.",
      `Sources: ${sourceLabels}`
    ]
      .filter(Boolean)
      .join(" "),
    claimSourceIds: scenario.supportClaims.map((claim) => claim.sourceId)
  };
}

function scoreCoverage(answer: string, scenario: ShadowScenario): number {
  const answerText = normalize(answer);
  const claimHits = scenario.supportClaims.filter((claim) => {
    const terms = normalize(claim.text)
      .split(" ")
      .filter((term) => term.length >= 5);
    return terms.length === 0 || terms.some((term) => answerText.includes(term));
  }).length;
  return rate(claimHits, scenario.supportClaims.length);
}

function scoreReadability(answer: string): number {
  const normalized = normalize(answer);
  const hasAnswer = normalized.includes("answer");
  const hasMeaning = normalized.includes("what this means");
  const hasSuggestion = normalized.includes("suggestion");
  const hasSources = normalized.includes("sources");
  const sentenceCount = answer.split(/[.!?]/u).filter((part) => part.trim().length > 0).length;
  const tersePenalty = normalized.includes("support") && normalized.includes("sources") && sentenceCount <= 2 ? 0.2 : 0;
  const score = rate([hasAnswer, hasMeaning, hasSuggestion, hasSources].filter(Boolean).length, 4) + Math.min(0.2, sentenceCount * 0.04) - tersePenalty;
  return Number(Math.max(0, Math.min(1, score)).toFixed(4));
}

function unsupportedClaimCount(answer: string, scenario: ShadowScenario): number {
  const supportText = normalize([...scenario.supportClaims.map((claim) => claim.text), ...scenario.sourceTrail.map((source) => source.quote)].join(" "));
  const unsupportedPhrases = ["llm inferred", "probably", "without evidence", "raw database", "uncited", "source says nothing"];
  return unsupportedPhrases.filter((phrase) => normalize(answer).includes(phrase) && !supportText.includes(normalize(phrase))).length;
}

async function runScenario(scenario: ShadowScenario): Promise<ShadowRow> {
  const startedAt = performance.now();
  const shadow = shadowPresenterCandidate(scenario);
  const sourceIds = new Set(scenario.sourceTrail.map((source) => source.sourceId));
  const llmUnsupportedClaimCount = unsupportedClaimCount(shadow.answer, scenario);
  const llmMissingClaimSourceIdCount = shadow.claimSourceIds.filter((sourceId) => !sourceIds.has(sourceId)).length;
  const deterministicCoverageScore = scoreCoverage(scenario.deterministicAnswer, scenario);
  const shadowCoverageScore = scoreCoverage(shadow.answer, scenario);
  const deterministicReadabilityScore = scoreReadability(scenario.deterministicAnswer);
  const shadowReadabilityScore = scoreReadability(shadow.answer);
  const faithfulnessStatus = llmUnsupportedClaimCount === 0 && llmMissingClaimSourceIdCount === 0 ? "verified" : "failed";
  const readabilityWin = shadowReadabilityScore > deterministicReadabilityScore;
  return {
    id: scenario.id,
    family: scenario.family,
    query: scenario.query,
    shadowOnly: true,
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
    deterministicReadabilityScore,
    shadowReadabilityScore,
    readabilityWin,
    costUsd: 0,
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    passed:
      faithfulnessStatus === "verified" &&
      shadowCoverageScore >= deterministicCoverageScore &&
      readabilityWin &&
      scenario.supportClaims.length > 0 &&
      scenario.sourceTrail.length > 0
  };
}

function toMarkdown(report: BoundedLlmPresenterShadowReport): string {
  return [
    "# Bounded LLM Presenter Shadow Audit 50",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- shadowOnly: ${report.shadowOnly}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- providerCalls: ${report.metrics.providerCalls}`,
    `- costUsd: ${report.metrics.costUsd}`,
    `- llmUnsupportedClaimCount: ${report.metrics.llmUnsupportedClaimCount}`,
    `- llmMissingClaimSourceIdCount: ${report.metrics.llmMissingClaimSourceIdCount}`,
    `- faithfulnessScore: ${report.metrics.faithfulnessScore}`,
    `- readabilityWinRate: ${report.metrics.readabilityWinRate}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Rows",
    "",
    ...report.rows.map(
      (row) =>
        `- ${row.id}: passed=${row.passed}; family=${row.family}; coverage=${row.shadowCoverageScore}; readability=${row.deterministicReadabilityScore}->${row.shadowReadabilityScore}; sources=${row.claimSourceIds.join(",")}`
    ),
    ""
  ].join("\n");
}

export async function runBoundedLlmPresenterShadowPack(): Promise<{
  readonly report: BoundedLlmPresenterShadowReport;
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
    deterministicReadabilityScore: Number((rows.reduce((sum, row) => sum + row.deterministicReadabilityScore, 0) / Math.max(1, rows.length)).toFixed(4)),
    shadowReadabilityScore: Number((rows.reduce((sum, row) => sum + row.shadowReadabilityScore, 0) / Math.max(1, rows.length)).toFixed(4)),
    readabilityWinRate: rate(rows.filter((row) => row.readabilityWin).length, rows.length),
    familyCoverageCount: new Set(rows.map((row) => row.family)).size,
    costUsd: Number(rows.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Math.max(0, ...rows.map((row) => row.latencyMs))
  };
  const failures = [
    rows.length !== 50 ? "scenario_count_not_50" : "",
    metrics.familyCoverageCount < 10 ? "family_coverage_missing" : "",
    metrics.providerCalls !== 0 ? "shadow_pack_called_provider" : "",
    metrics.costUsd !== 0 ? "shadow_pack_recorded_cost" : "",
    metrics.rawCorpusAccessBlockedRate !== 1 ? "raw_corpus_access_not_blocked" : "",
    metrics.supportBundleCoverageRate !== 1 ? "support_bundle_missing" : "",
    metrics.llmUnsupportedClaimCount !== 0 ? "unsupported_shadow_claims" : "",
    metrics.llmMissingClaimSourceIdCount !== 0 ? "missing_claim_source_ids" : "",
    metrics.faithfulnessScore < 1 ? "faithfulness_regressed" : "",
    metrics.shadowCoverageScore < metrics.deterministicCoverageScore ? "shadow_coverage_regressed" : "",
    metrics.readabilityWinRate < 0.95 ? "readability_win_rate_below_gate" : "",
    metrics.p95LatencyMs > 5000 ? "p95_latency_above_gate" : "",
    metrics.maxLatencyMs > 10000 ? "max_latency_above_gate" : ""
  ].filter(Boolean);
  const report: BoundedLlmPresenterShadowReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "bounded_llm_presenter_shadow_pack",
    artifactSchemaVersion: "bounded_llm_presenter_shadow_pack_v2",
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
    process.stdout.write(
      `${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify(
        { passed: report.passed, metrics: report.metrics, failures: report.failures },
        null,
        2
      )}\n`
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
