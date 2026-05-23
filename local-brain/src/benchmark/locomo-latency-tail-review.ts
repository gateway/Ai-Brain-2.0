import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { closePool } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { runNamespaceVectorActivation } from "../jobs/vector-sync-runtime.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { ingestLoCoMoSessionArtifacts } from "./locomo-ingest.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";
import {
  buildBenchmarkVectorActivationMetadata,
  createBenchmarkVectorActivationAccumulator,
  mergeBenchmarkVectorActivation
} from "./vector-activation.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
  readonly dia_id?: string;
  readonly img_url?: readonly string[];
}

interface LocomoConversation {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly TurnRecord[]>;
  readonly qa: readonly {
    readonly question: string;
    readonly answer?: string | number;
    readonly category: number;
  }[];
}

interface LatencyTailScenarioDefinition {
  readonly family:
    | "descriptive_place_activity"
    | "bounded_event_detail"
    | "temporal_exact_detail"
    | "paired_person_exact_detail"
    | "sparse_profile_inference"
    | "commonality_aggregation";
  readonly sampleId: string;
  readonly question: string;
  readonly runtimeQuery?: string;
}

interface LatencyTailScenarioResult {
  readonly family: LatencyTailScenarioDefinition["family"];
  readonly sampleId: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly latencyMs: number;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string | null;
  readonly confidence: string | null;
  readonly sufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly branchPruningApplied: boolean;
  readonly prunedBranches: readonly string[];
  readonly leafTraversalTriggered: boolean;
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly initialLaneSufficiency: string | null;
  readonly finalLaneSufficiency: string | null;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly neighborExpansionCount: number;
  readonly typedLaneDepth: number;
  readonly recursiveSubqueryCount: number;
  readonly latencyBudgetFamily: string | null;
  readonly earlyStopReason: string | null;
  readonly reducerFamily: string | null;
  readonly finalClaimSource: string | null;
  readonly fallbackSuppressedReason: string | null;
  readonly vectorCandidateCount: number;
  readonly vectorContributedToFinalSupport: boolean;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
}

export interface LoCoMoLatencyTailReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly scenarioCount: number;
  readonly families: Readonly<Record<string, { readonly count: number; readonly passRate: number; readonly normalizedPassRate: number; readonly p50Ms: number; readonly p95Ms: number }>>;
  readonly scenarios: readonly LatencyTailScenarioResult[];
}

const SCENARIOS: readonly LatencyTailScenarioDefinition[] = [
  { family: "bounded_event_detail", sampleId: "conv-44", question: "Which meat does Audrey prefer eating more than others?" },
  { family: "bounded_event_detail", sampleId: "conv-30", question: "What is Jon's favorite style of painting?" },
  { family: "bounded_event_detail", sampleId: "conv-26", question: "What did Caroline research?" },
  { family: "descriptive_place_activity", sampleId: "conv-44", question: "What is an indoor activity that Andrew would enjoy doing while make his dog happy?" },
  { family: "descriptive_place_activity", sampleId: "conv-44", question: "What kind of places have Andrew and his girlfriend checked out around the city?" },
  {
    family: "commonality_aggregation",
    sampleId: "conv-30",
    question: "Which city have both Jean and John visited?",
    runtimeQuery: "Which city have both Jon and Gina visited?"
  },
  { family: "commonality_aggregation", sampleId: "conv-41", question: "What type of volunteering have John and Maria both done?" },
  { family: "commonality_aggregation", sampleId: "conv-42", question: "What kind of interests do Joanna and Nate share?" },
  { family: "paired_person_exact_detail", sampleId: "conv-43", question: "Would Tim enjoy reading books by C. S. Lewis or John Greene?" },
  { family: "sparse_profile_inference", sampleId: "conv-47", question: "Does James live in Connecticut?" },
  { family: "sparse_profile_inference", sampleId: "conv-48", question: "Is Deborah married?" },
  { family: "sparse_profile_inference", sampleId: "conv-50", question: "Does Dave's shop employ a lot of people?" },
  { family: "temporal_exact_detail", sampleId: "conv-41", question: "When did Maria donate her car?" },
  { family: "temporal_exact_detail", sampleId: "conv-47", question: "Which recreational activity was James pursuing on March 16, 2022?" }
] as const;

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
  return path.resolve(localBrainRoot(), "benchmark-generated", "locomo-latency-tail-review");
}

function searchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadCached(url: string, fileName: string): Promise<string> {
  const destination = path.join(generatedRoot(), "raw", fileName);
  try {
    return await readFile(destination, "utf8");
  } catch {
    await mkdir(path.dirname(destination), { recursive: true });
    const body = await searchText(url);
    await writeFile(destination, body, "utf8");
    return body;
  }
}

function benchmarkExpectedAnswer(qa: { readonly answer?: string | number; readonly category: number }): string {
  if (typeof qa.answer === "string" && qa.answer.trim().length > 0) {
    return qa.answer;
  }
  if (typeof qa.answer === "number" && Number.isFinite(qa.answer)) {
    return String(qa.answer);
  }
  return qa.category === 5 ? "None" : "";
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactNormalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function extractCompactAnswerItems(value: unknown): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[,\n;]+/g)
        .map((item) => compactNormalize(item))
        .filter((item) => item.length > 2)
    )
  ];
}

function compactListPass(expectedAnswer: string, compactCandidate: string): boolean {
  const expectedItems = extractCompactAnswerItems(expectedAnswer);
  return expectedItems.length >= 2 && expectedItems.every((item) => compactCandidate.includes(item));
}

function normalizedAnswerPass(expectedAnswer: string, payload: any): boolean {
  const candidateTexts = [
    payload?.duality?.claim?.text,
    payload?.summaryText,
    payload?.claimText,
    payload?.explanation,
    ...(Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.map((item: any) => item?.snippet) : [])
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const candidates = candidateTexts.map((item) => normalize(item));
  const compactCandidates = candidateTexts.map((item) => compactNormalize(item));
  const expected = normalize(expectedAnswer);
  const compactExpected = compactNormalize(expectedAnswer);
  if (!expected || candidates.length === 0) {
    return false;
  }
  if (candidates.some((candidate) => candidate.includes(expected))) {
    return true;
  }
  if (compactExpected && compactCandidates.some((candidate) => candidate.includes(compactExpected))) {
    return true;
  }
  if (compactCandidates.some((candidate) => compactListPass(expectedAnswer, candidate))) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  return candidates.some((candidate) => {
    const hitCount = expectedTokens.filter((token) => candidate.includes(token)).length;
    return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.75;
  });
}

function bestEffortPass(expectedAnswer: string, payload: any): boolean {
  const haystack = normalize(JSON.stringify(payload));
  const expected = normalize(expectedAnswer);
  const compactHaystack = compactNormalize(JSON.stringify(payload));
  const compactExpected = compactNormalize(expectedAnswer);
  if (!expected) {
    return false;
  }
  if (haystack.includes(expected)) {
    return true;
  }
  if (compactExpected && compactHaystack.includes(compactExpected)) {
    return true;
  }
  if (compactListPass(expectedAnswer, compactHaystack)) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  const hitCount = expectedTokens.filter((token) => haystack.includes(token)).length;
  return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.6;
}

function sourceCount(payload: any): number {
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  return new Set(
    evidence
      .map((item: any) =>
        typeof item?.sourceUri === "string" && item.sourceUri
          ? item.sourceUri
          : typeof item?.artifactId === "string" && item.artifactId
            ? item.artifactId
            : null
      )
      .filter((value: string | null): value is string => Boolean(value))
  ).size;
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function trimSnippet(value: unknown, max = 220): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function stageTimingsFromPayload(payload: any): Readonly<Record<string, number>> | null {
  if (!payload?.meta?.stageTimingsMs || typeof payload.meta.stageTimingsMs !== "object") {
    return null;
  }
  const timings: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload.meta.stageTimingsMs)) {
    if (typeof key === "string" && typeof value === "number") {
      timings[key] = value;
    }
  }
  return timings;
}

function toMarkdown(report: LoCoMoLatencyTailReviewReport): string {
  const lines = [
    "# LoCoMo Latency-Tail Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- scenarioCount: ${report.scenarioCount}`,
    "",
    "## Families",
    ""
  ];

  for (const [family, summary] of Object.entries(report.families)) {
    lines.push(`- ${family}: count=${summary.count} passRate=${summary.passRate} normalizedPassRate=${summary.normalizedPassRate} p50Ms=${summary.p50Ms} p95Ms=${summary.p95Ms}`);
  }

  lines.push("", "## Scenarios", "");
  for (const scenario of report.scenarios) {
    lines.push(
      `- ${scenario.family} | ${scenario.sampleId} | ${scenario.normalizedPassed ? "pass" : "fail"} | latencyMs=${scenario.latencyMs} | dominantStage=${scenario.dominantStage ?? "n/a"} | finalClaimSource=${scenario.finalClaimSource ?? "n/a"}`
    );
    lines.push(`  - q: ${scenario.question}`);
    lines.push(`  - expected: ${scenario.expectedAnswer}`);
    if (scenario.answerSnippet) {
      lines.push(`  - answer: ${scenario.answerSnippet}`);
    }
    lines.push(`  - confidence/sufficiency/subjectMatch: ${scenario.confidence ?? "n/a"} / ${scenario.sufficiency ?? "n/a"} / ${scenario.subjectMatch ?? "n/a"}`);
    lines.push(`  - evidence/sources: ${scenario.evidenceCount}/${scenario.sourceCount}`);
    if (scenario.descentStages.length > 0) {
      lines.push(`  - descentStages: ${scenario.descentStages.join(" -> ")}`);
    }
    if (scenario.reducerFamily) {
      lines.push(`  - reducerFamily: ${scenario.reducerFamily}`);
    }
    if (scenario.fallbackSuppressedReason) {
      lines.push(`  - fallbackSuppressedReason: ${scenario.fallbackSuppressedReason}`);
    }
    if (scenario.stageTimingsMs) {
      lines.push(`  - stageTimingsMs: ${JSON.stringify(scenario.stageTimingsMs)}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runScenario(namespaceId: string, scenario: LatencyTailScenarioDefinition, expectedAnswer: string): Promise<LatencyTailScenarioResult> {
  const startedAt = performance.now();
  const runtimeQuery = scenario.runtimeQuery ?? scenario.question;
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: runtimeQuery,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));

  return {
    family: scenario.family,
    sampleId: scenario.sampleId,
    question: runtimeQuery,
    expectedAnswer,
    passed: bestEffortPass(expectedAnswer, payload),
    normalizedPassed: normalizedAnswerPass(expectedAnswer, payload),
    latencyMs,
    evidenceCount: Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.length : 0,
    sourceCount: sourceCount(payload),
    answerSnippet: trimSnippet(payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.explanation),
    confidence: typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null,
    sufficiency: typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null,
    subjectMatch: typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null,
    branchPruningApplied: payload?.meta?.branchPruningApplied === true,
    prunedBranches: Array.isArray(payload?.meta?.prunedBranches) ? payload.meta.prunedBranches.filter((value: unknown): value is string => typeof value === "string") : [],
    leafTraversalTriggered: payload?.meta?.leafTraversalTriggered === true,
    descentTriggered: payload?.meta?.descentTriggered === true,
    descentStages: Array.isArray(payload?.meta?.descentStages) ? payload.meta.descentStages.filter((value: unknown): value is string => typeof value === "string") : [],
    initialLaneSufficiency: typeof payload?.meta?.initialLaneSufficiency === "string" ? payload.meta.initialLaneSufficiency : null,
    finalLaneSufficiency: typeof payload?.meta?.finalLaneSufficiency === "string" ? payload.meta.finalLaneSufficiency : null,
    dominantStage: typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : null,
    topStageMs: typeof payload?.meta?.topStageMs === "number" ? payload.meta.topStageMs : null,
    neighborExpansionCount: typeof payload?.meta?.neighborExpansionCount === "number" ? payload.meta.neighborExpansionCount : 0,
    typedLaneDepth: typeof payload?.meta?.typedLaneDepth === "number" ? payload.meta.typedLaneDepth : 0,
    recursiveSubqueryCount: typeof payload?.meta?.recursiveSubqueryCount === "number" ? payload.meta.recursiveSubqueryCount : 0,
    latencyBudgetFamily: typeof payload?.meta?.latencyBudgetFamily === "string" ? payload.meta.latencyBudgetFamily : null,
    earlyStopReason: typeof payload?.meta?.earlyStopReason === "string" ? payload.meta.earlyStopReason : null,
    reducerFamily: typeof payload?.meta?.reducerFamily === "string" ? payload.meta.reducerFamily : null,
    finalClaimSource: typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null,
    fallbackSuppressedReason: typeof payload?.meta?.fallbackSuppressedReason === "string" ? payload.meta.fallbackSuppressedReason : null,
    vectorCandidateCount: typeof payload?.meta?.vectorCandidateCount === "number" ? payload.meta.vectorCandidateCount : 0,
    vectorContributedToFinalSupport: payload?.meta?.vectorContributedToFinalSupport === true,
    stageTimingsMs: stageTimingsFromPayload(payload)
  };
}

export async function runAndWriteLoCoMoLatencyTailReview(): Promise<{
  readonly report: LoCoMoLatencyTailReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  await runMigrations();
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const runtimeBase = buildBenchmarkRuntimeMetadata({
    benchmarkMode: "sampled",
    sampleControls: {
      suite: "locomo_latency_tail_review",
      scenarioCount: SCENARIOS.length
    }
  });
  const config = readConfig();
  let vectorActivation = createBenchmarkVectorActivationAccumulator(
    "benchmark",
    config.benchmarkVectorActivationMode,
    runtimeBase.embeddingProvider,
    runtimeBase.embeddingModel
  );
  const runtime = (): BenchmarkRuntimeMetadata =>
    buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: runtimeBase.sampleControls,
      vectorActivation: buildBenchmarkVectorActivationMetadata(vectorActivation)
    });
  const raw = await downloadCached(
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    "locomo10.json"
  );
  const dataset = JSON.parse(raw) as readonly LocomoConversation[];
  const sampleMap = new Map(dataset.map((sample) => [sample.sample_id, sample]));
  const scenarioGroups = new Map<string, LatencyTailScenarioDefinition[]>();
  for (const scenario of SCENARIOS) {
    const group = scenarioGroups.get(scenario.sampleId);
    if (group) {
      group.push(scenario);
    } else {
      scenarioGroups.set(scenario.sampleId, [scenario]);
    }
  }

  await mkdir(outputDir(), { recursive: true });
  await mkdir(generatedRoot(), { recursive: true });

  const results: LatencyTailScenarioResult[] = [];
  const namespacesToCleanup: string[] = [];

  try {
    for (const [sampleId, sampleScenarios] of scenarioGroups.entries()) {
      const sample = sampleMap.get(sampleId);
      if (!sample) {
        throw new Error(`Missing LoCoMo sample ${sampleId}`);
      }
      const namespaceId = `benchmark_latency_tail_${stamp}_${sample.sample_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      namespacesToCleanup.push(namespaceId);
      const sampleRoot = path.join(generatedRoot(), namespaceId);
      await mkdir(sampleRoot, { recursive: true });
      const sessionEntries = Object.entries(sample.conversation).filter(
        ([key, value]) => key.startsWith("session_") && Array.isArray(value)
      ) as Array<[string, readonly TurnRecord[]]>;

      for (const [sessionKey, turns] of sessionEntries) {
        const ingestResult = await ingestLoCoMoSessionArtifacts({
          localBrainRoot: localBrainRoot(),
          benchmarkName: "locomo_latency_tail_review",
          corpusRoot: sampleRoot,
          namespaceId,
          sample,
          sessionKey,
          turns
        });
        if (ingestResult.imageArtifactCount > 0) {
          console.log(
            `[locomo-latency-tail-review] sample=${sample.sample_id} session=${sessionKey} imageArtifacts=${ingestResult.imageArtifactCount} imageDerivations=${ingestResult.derivedImageCount} cacheHits=${ingestResult.imageDerivationCacheHits}`
          );
        }
      }

      await rebuildTypedMemoryNamespace(namespaceId);
      vectorActivation = mergeBenchmarkVectorActivation(
        vectorActivation,
        await runNamespaceVectorActivation({
          namespaceId,
          scope: "benchmark",
          reason: "benchmark_locomo_latency_tail_review"
        })
      );

      for (const scenario of sampleScenarios) {
        const qa = sample.qa.find((candidate) => candidate.question === scenario.question);
        if (!qa) {
          throw new Error(`Missing QA pair for ${sample.sample_id}: ${scenario.question}`);
        }
        results.push(await runScenario(namespaceId, scenario, benchmarkExpectedAnswer(qa)));
      }
    }

    const families = Object.fromEntries(
      [...new Set(results.map((result) => result.family))].sort().map((family) => {
        const familyResults = results.filter((result) => result.family === family);
        return [
          family,
          {
            count: familyResults.length,
            passRate: Number((familyResults.filter((result) => result.passed).length / Math.max(1, familyResults.length)).toFixed(3)),
            normalizedPassRate: Number((familyResults.filter((result) => result.normalizedPassed).length / Math.max(1, familyResults.length)).toFixed(3)),
            p50Ms: percentile(familyResults.map((result) => result.latencyMs), 50),
            p95Ms: percentile(familyResults.map((result) => result.latencyMs), 95)
          }
        ];
      })
    );

    const report: LoCoMoLatencyTailReviewReport = {
      generatedAt,
      runtime: runtime(),
      scenarioCount: results.length,
      families,
      scenarios: results
    };

    const jsonPath = path.join(outputDir(), `locomo-latency-tail-review-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `locomo-latency-tail-review-${stamp}.md`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return { report, output: { jsonPath, markdownPath } };
  } finally {
    if (namespacesToCleanup.length > 0) {
      await cleanupPublicBenchmarkNamespaces(namespacesToCleanup, {
        namespaceChunkSize: 1,
        statementTimeoutMs: 60_000,
        lockTimeoutMs: 2_000
      }).catch(() => {});
    }
  }
}

export async function runLoCoMoLatencyTailReviewCli(): Promise<void> {
  try {
    const { output, report } = await runAndWriteLoCoMoLatencyTailReview();
    process.stdout.write(`${JSON.stringify({ families: report.families, output }, null, 2)}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}
