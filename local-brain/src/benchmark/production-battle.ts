import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteDemoReadinessBenchmark } from "./demo-readiness.js";
import { runAndWriteExternalAcceptanceBenchmark } from "./external-acceptance.js";
import { runAndWriteHardeningSuitesBenchmark } from "./hardening-suites.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";
import { runAndWriteLifeReplayBenchmark } from "./life-replay.js";
import { runAndWriteLifeScaleBenchmark } from "./life-scale.js";
import { runAndWriteMcpSmokeBenchmark } from "./mcp-smoke.js";
import { runAndWriteMultimodalWorkerSmokeBenchmark } from "./multimodal-worker-smoke.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";
import { runAndWriteNoteReconsolidationReviewBenchmark } from "./note-reconsolidation-review.js";
import { runAndWriteGraphRetrievalReviewBenchmark } from "./graph-retrieval-review.js";
import { runAndWritePublicDatasetWatchBenchmark } from "./public-dataset-watch.js";
import { runAndWritePublicMemoryMissRegressionsBenchmark } from "./public-memory-miss-regressions.js";
import { runAndWriteRecapFamilyBenchmark } from "./recap-family.js";
import { runAndWriteRecapProviderParityBenchmark } from "./recap-provider-parity.js";
import { runAndWriteRecursiveReflectReviewBenchmark } from "./recursive-reflect-review.js";
import { runAndWriteProfileRoutingReviewBenchmark } from "./profile-routing-review.js";
import { runAndWriteSessionStartMemoryBenchmark } from "./session-start-memory.js";
import { runAndWriteSharedCausalReviewBenchmark } from "./shared-causal-review.js";
import { runAndWriteTaskCalendarExtractionBenchmark } from "./task-calendar-extraction.js";
import { runAndWriteTemporalDifferentialBenchmark } from "./temporal-differential.js";

interface LongFormScenario {
  readonly name: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: "confident" | "weak" | "missing";
  readonly minimumEvidence: number;
  readonly requireDecomposition?: boolean;
}

interface LongFormScenarioResult {
  readonly name: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly confidence?: string;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly decompositionApplied: boolean;
  readonly subqueries: readonly string[];
}

interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly artifactPath: string;
}

export interface ProductionBattleReport {
  readonly generatedAt: string;
  readonly targetPassRatePercent: number;
  readonly achievedPassRatePercent: number;
  readonly releaseGatePassed: boolean;
  readonly gates: readonly GateResult[];
  readonly longFormResults: readonly LongFormScenarioResult[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  return [];
}

function sourceLinkCount(items: readonly any[]): number {
  let count = 0;
  for (const item of items) {
    if (typeof item?.artifactId === "string" && item.artifactId) {
      count += 1;
      continue;
    }
    if (typeof item?.sourceUri === "string" && item.sourceUri) {
      count += 1;
    }
  }
  return count;
}

function longFormScenarios(): readonly LongFormScenario[] {
  return [
    {
      name: "personal_broad_2025_life_summary",
      namespaceId: "personal",
      query:
        "I am trying to remember my life a bit more like a normal person would, not like a database query. Can you help me piece together what 2025 was like for Steve? I vaguely remember travel, changes in where he was living, friends, work, and maybe some relationship stuff, but I do not remember the exact dates very well. I also want to know who his close people were, who he worked with, what projects were important, whether there were any big changes in beliefs or infrastructure opinions during 2025, and what kinds of movies or things he liked around that period. If there are any places that mattered, like where he lived before and after Thailand or places tied to people like Lauren, include that too. If part of this is uncertain, say what is solid versus what still needs clarification, and show why the brain believes the main claims instead of just summarizing loosely.",
      expectedTerms: ["Chiang Mai", "Two-Way", "Trainspotting", "Lauren"],
      expectedConfidence: "confident",
      minimumEvidence: 4,
      requireDecomposition: true
    },
    {
      name: "synthetic_broad_recent_life_summary",
      namespaceId: "synthetic_human_sandbox",
      query:
        "I am blanking on the last little stretch of Steve's life and want a normal human recap. Tell me who he has been around lately, where he has lived, what he has been doing on weekends and at coworking, whether anything changed with Lauren, what movies he watched recently, and what current preferences or constraints matter. I do not really remember exact timestamps, so pull together the solid parts and separate anything that still looks unresolved.",
      expectedTerms: ["Jules", "Omar", "Chiang Mai", "Lauren", "Sinners", "mild"],
      expectedConfidence: "confident",
      minimumEvidence: 4,
      requireDecomposition: true
    },
    {
      name: "public_broad_profile_summary",
      namespaceId: "public_dataset_watch",
      query:
        "I am trying to remember what Martin Mark's life looks like right now instead of reading a profile blob. Can you piece together where he lives, who his close people and coworkers are, what kinds of travel or places he prefers, and anything solid we know versus anything that still needs clarification? Please show why the brain believes the main points instead of only giving a loose summary.",
      expectedTerms: ["Martin Mark", "Columbus", "Susan Thomas", "Wellness retreats"],
      expectedConfidence: "confident",
      minimumEvidence: 4,
      requireDecomposition: true
    }
  ];
}

async function executeLongFormScenario(scenario: LongFormScenario): Promise<LongFormScenarioResult> {
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    limit: 10
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped?.structuredContent as any;
  const failures: string[] = [];
  const evidence = evidenceItems(payload);
  const confidence = typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : undefined;
  const decompositionApplied = payload?.meta?.queryDecomposition?.applied === true;
  const subqueries = Array.isArray(payload?.meta?.queryDecomposition?.subqueries)
    ? payload.meta.queryDecomposition.subqueries.filter((item: unknown): item is string => typeof item === "string")
    : [];

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }

  if (confidence !== scenario.expectedConfidence) {
    failures.push(`expected confidence ${scenario.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }

  if (evidence.length < scenario.minimumEvidence) {
    failures.push(`expected at least ${scenario.minimumEvidence} evidence rows, got ${evidence.length}`);
  }

  if (scenario.requireDecomposition && !decompositionApplied) {
    failures.push("expected query decomposition for long mixed-intent prompt");
  }

  return {
    name: scenario.name,
    namespaceId: scenario.namespaceId,
    passed: failures.length === 0,
    failures,
    confidence,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    decompositionApplied,
    subqueries
  };
}

function toMarkdown(report: ProductionBattleReport): string {
  const lines = [
    "# Production Battle Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- targetPassRatePercent: ${report.targetPassRatePercent}`,
    `- achievedPassRatePercent: ${report.achievedPassRatePercent}`,
    `- releaseGatePassed: ${report.releaseGatePassed}`,
    "",
    "## Gates",
    ""
  ];

  for (const gate of report.gates) {
    lines.push(`- ${gate.name}: ${gate.passed ? "pass" : "fail"} | ${gate.artifactPath}`);
  }

  lines.push("", "## Long Form", "");
  for (const result of report.longFormResults) {
    lines.push(
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount} | decomposition=${result.decompositionApplied}`
    );
    if (result.subqueries.length > 0) {
      lines.push(`  - subqueries: ${result.subqueries.join(" | ")}`);
    }
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteProductionBattleBenchmark(): Promise<{
  readonly report: ProductionBattleReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const replay = await runAndWriteLifeReplayBenchmark();
  const scale = await runAndWriteLifeScaleBenchmark();
  const demoReadiness = await runAndWriteDemoReadinessBenchmark();
  const externalAcceptance = await runAndWriteExternalAcceptanceBenchmark();
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const hardeningSuites = await runAndWriteHardeningSuitesBenchmark();
  const publicDataset = await runAndWritePublicDatasetWatchBenchmark();
  const publicMissRegressions = await runAndWritePublicMemoryMissRegressionsBenchmark();
  const profileRoutingReview = await runAndWriteProfileRoutingReviewBenchmark();
  const noteReconsolidationReview = await runAndWriteNoteReconsolidationReviewBenchmark();
  const graphRetrievalReview = await runAndWriteGraphRetrievalReviewBenchmark();
  const recursiveReflectReview = await runAndWriteRecursiveReflectReviewBenchmark();
  const recapFamily = await runAndWriteRecapFamilyBenchmark();
  const taskCalendar = await runAndWriteTaskCalendarExtractionBenchmark();
  const sessionStart = await runAndWriteSessionStartMemoryBenchmark();
  const sharedCausalReview = await runAndWriteSharedCausalReviewBenchmark();
  const recapProviderParity = await runAndWriteRecapProviderParityBenchmark();
  const temporalDifferential = await runAndWriteTemporalDifferentialBenchmark();

  const longFormResults: LongFormScenarioResult[] = [];
  const publicScenario = longFormScenarios().find((scenario) => scenario.name === "public_broad_profile_summary");
  if (publicScenario) {
    longFormResults.push(
      await executeLongFormScenario({
        ...publicScenario,
        namespaceId: publicDataset.report.namespaceId
      })
    );
  }

  const mcp = await runAndWriteMcpSmokeBenchmark();
  const omi = await runAndWriteOmiWatchSmokeBenchmark();
  const multimodal = await runAndWriteMultimodalWorkerSmokeBenchmark();

  const remainingScenarios = longFormScenarios().filter((scenario) => scenario.name !== "public_broad_profile_summary");
  for (const scenario of remainingScenarios) {
    longFormResults.push(await executeLongFormScenario(scenario));
  }

  const gates: GateResult[] = [
    { name: "life_replay", passed: replay.report.passed, artifactPath: replay.output.jsonPath },
    { name: "life_scale", passed: scale.report.passed, artifactPath: scale.output.jsonPath },
    { name: "demo_readiness", passed: demoReadiness.report.passed, artifactPath: demoReadiness.output.jsonPath },
    { name: "external_acceptance", passed: externalAcceptance.report.passed, artifactPath: externalAcceptance.output.jsonPath },
    { name: "human_synthetic_watch", passed: synthetic.report.passed, artifactPath: synthetic.output.jsonPath },
    { name: "hardening_suites", passed: hardeningSuites.report.passed, artifactPath: hardeningSuites.output.jsonPath },
    { name: "public_dataset_watch", passed: publicDataset.report.passed, artifactPath: publicDataset.output.jsonPath },
    { name: "public_memory_miss_regressions", passed: publicMissRegressions.report.passed, artifactPath: publicMissRegressions.output.jsonPath },
    { name: "profile_routing_review", passed: profileRoutingReview.report.summary.fail === 0, artifactPath: profileRoutingReview.output.jsonPath },
    { name: "note_reconsolidation_review", passed: noteReconsolidationReview.report.summary.fail === 0, artifactPath: noteReconsolidationReview.output.jsonPath },
    { name: "graph_retrieval_review", passed: graphRetrievalReview.report.summary.fail === 0, artifactPath: graphRetrievalReview.output.jsonPath },
    { name: "recursive_reflect_review", passed: recursiveReflectReview.report.summary.fail === 0, artifactPath: recursiveReflectReview.output.jsonPath },
    { name: "recap_family", passed: recapFamily.report.passed, artifactPath: recapFamily.output.jsonPath },
    { name: "task_calendar_extraction", passed: taskCalendar.report.passed, artifactPath: taskCalendar.output.jsonPath },
    { name: "session_start_memory", passed: sessionStart.report.passed, artifactPath: sessionStart.output.jsonPath },
    { name: "shared_causal_review", passed: sharedCausalReview.report.summary.fail === 0, artifactPath: sharedCausalReview.output.jsonPath },
    { name: "recap_provider_parity", passed: recapProviderParity.report.passed, artifactPath: recapProviderParity.output.jsonPath },
    { name: "temporal_differential", passed: temporalDifferential.report.passed, artifactPath: temporalDifferential.output.jsonPath },
    { name: "mcp_smoke", passed: mcp.report.passed, artifactPath: mcp.output.jsonPath },
    { name: "omi_watch", passed: omi.report.passed, artifactPath: omi.output.jsonPath },
    { name: "multimodal_worker_smoke", passed: multimodal.report.passed, artifactPath: multimodal.output.jsonPath }
  ];

  const passedCount = gates.filter((item) => item.passed).length + longFormResults.filter((item) => item.passed).length;
  const totalCount = gates.length + longFormResults.length;
  const achievedPassRatePercent = Number(((passedCount / totalCount) * 100).toFixed(2));
  const targetPassRatePercent = 98;

  const report: ProductionBattleReport = {
    generatedAt: new Date().toISOString(),
    targetPassRatePercent,
    achievedPassRatePercent,
    releaseGatePassed: achievedPassRatePercent >= targetPassRatePercent && gates.every((item) => item.passed) && longFormResults.every((item) => item.passed),
    gates,
    longFormResults
  };

  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outDir, `production-battle-${timestamp}.json`);
  const markdownPath = path.join(outDir, `production-battle-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");

  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runProductionBattleBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteProductionBattleBenchmark();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
