import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
  readonly query?: string;
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

interface PressureScenarioDefinition {
  readonly family:
    | "paired_person_event_date"
    | "place_shop_country_resolution"
    | "family_pet_adoption_ownership"
    | "descriptive_place_activity"
    | "music_media_disambiguation"
    | "symbolic_gift_family_resolution"
    | "travel_temporal_exact_detail";
  readonly sampleId: string;
  readonly question: string;
}

interface PressureScenarioResult {
  readonly family: PressureScenarioDefinition["family"];
  readonly sampleId: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly latencyMs: number;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string | null;
  readonly branchPruningApplied: boolean;
  readonly prunedBranches: readonly string[];
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly initialLaneSufficiency: string | null;
  readonly finalLaneSufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly sufficiency: string | null;
}

export interface FullStandardPressureReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly scenarioCount: number;
  readonly families: Readonly<Record<string, { readonly count: number; readonly passRate: number; readonly normalizedPassRate: number; readonly p50Ms: number; readonly p95Ms: number }>>;
  readonly scenarios: readonly PressureScenarioResult[];
}

const SCENARIOS: readonly PressureScenarioDefinition[] = [
  { family: "paired_person_event_date", sampleId: "conv-43", question: "Which team did John sign with on 21 May, 2023?" },
  { family: "paired_person_event_date", sampleId: "conv-43", question: "Which team did Tim sign with on 21 May, 2023?" },
  { family: "paired_person_event_date", sampleId: "conv-43", question: "What is Tim's position on the team he signed with?" },
  { family: "place_shop_country_resolution", sampleId: "conv-43", question: "Based on Tim's collections, what is a shop that he would enjoy visiting in New York city?" },
  { family: "descriptive_place_activity", sampleId: "conv-44", question: "What kind of indoor activities has Andrew pursued with his girlfriend?" },
  { family: "descriptive_place_activity", sampleId: "conv-44", question: "What kind of places have Andrew and his girlfriend checked out around the city?" },
  { family: "descriptive_place_activity", sampleId: "conv-44", question: "What kind of flowers does Andrew have a tattoo of?" },
  { family: "family_pet_adoption_ownership", sampleId: "conv-47", question: "What did John adopt in April 2022?" },
  { family: "family_pet_adoption_ownership", sampleId: "conv-47", question: "What is the name of the kitten that was adopted by James?" },
  { family: "symbolic_gift_family_resolution", sampleId: "conv-48", question: "What are the names of Jolene's snakes?" },
  { family: "symbolic_gift_family_resolution", sampleId: "conv-48", question: "What are the names of Deborah's snakes?" },
  { family: "symbolic_gift_family_resolution", sampleId: "conv-48", question: "What symbolic gifts do Deborah and Jolene have from their mothers?" },
  { family: "symbolic_gift_family_resolution", sampleId: "conv-48", question: "Which of Deborah`s family and friends have passed away?" },
  { family: "music_media_disambiguation", sampleId: "conv-50", question: "Which bands has Dave enjoyed listening to?" },
  { family: "music_media_disambiguation", sampleId: "conv-50", question: "Which band was Dave's favorite at the music festival in April 2023?" },
  { family: "music_media_disambiguation", sampleId: "conv-50", question: "Which DJ was Dave's favorite at the music festival in April 2023?" },
  { family: "place_shop_country_resolution", sampleId: "conv-50", question: "Which country do Calvin and Dave want to meet in?" },
  { family: "travel_temporal_exact_detail", sampleId: "conv-50", question: "When did Calvin first travel to Tokyo?" },
  { family: "travel_temporal_exact_detail", sampleId: "conv-50", question: "When did Dave see Aerosmith perform live?" }
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "full-standard-pressure-review");
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

function formatConversationSession(sample: LocomoConversation, sessionKey: string, turns: readonly TurnRecord[]): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`, "");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`, "");
  }
  lines.push(`Conversation between ${speakerA} and ${speakerB}`);
  for (const turn of turns) {
    const caption = typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0 ? ` [image: ${turn.blip_caption.trim()}]` : "";
    lines.push(`${turn.speaker}: ${(turn.text ?? "").trim()}${caption}`);
    if (typeof turn.query === "string" && turn.query.trim().length > 0) {
      lines.push(`--- image_query: ${turn.query.trim()}`);
    }
    if (typeof turn.blip_caption === "string" && turn.blip_caption.trim().length > 0) {
      lines.push(`--- image_caption: ${turn.blip_caption.trim()}`);
    }
  }
  return lines.join("\n");
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

function toMarkdown(report: FullStandardPressureReviewReport): string {
  const lines = [
    "# Full Standard Pressure Review",
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
    lines.push(`- ${scenario.family} | ${scenario.sampleId} | ${scenario.normalizedPassed ? "pass" : "fail"} | latencyMs=${scenario.latencyMs} | sufficiency=${scenario.sufficiency ?? "n/a"} | subjectMatch=${scenario.subjectMatch ?? "n/a"} | descentTriggered=${scenario.descentTriggered}`);
    lines.push(`  - q: ${scenario.question}`);
    lines.push(`  - expected: ${scenario.expectedAnswer}`);
    if (scenario.answerSnippet) {
      lines.push(`  - answer: ${scenario.answerSnippet}`);
    }
    if (scenario.prunedBranches.length > 0) {
      lines.push(`  - pruned: ${scenario.prunedBranches.join(", ")}`);
    }
    if (scenario.descentStages.length > 0) {
      lines.push(`  - descentStages: ${scenario.descentStages.join(" -> ")}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runScenario(namespaceId: string, scenario: PressureScenarioDefinition, expectedAnswer: string): Promise<PressureScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.question,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  return {
    family: scenario.family,
    sampleId: scenario.sampleId,
    question: scenario.question,
    expectedAnswer,
    passed: bestEffortPass(expectedAnswer, payload),
    normalizedPassed: normalizedAnswerPass(expectedAnswer, payload),
    latencyMs,
    evidenceCount: Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.length : 0,
    sourceCount: sourceCount(payload),
    answerSnippet: trimSnippet(payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.explanation),
    branchPruningApplied: payload?.meta?.branchPruningApplied === true,
    prunedBranches: Array.isArray(payload?.meta?.prunedBranches) ? payload.meta.prunedBranches.filter((value: unknown): value is string => typeof value === "string") : [],
    descentTriggered: payload?.meta?.descentTriggered === true,
    descentStages: Array.isArray(payload?.meta?.descentStages) ? payload.meta.descentStages.filter((value: unknown): value is string => typeof value === "string") : [],
    initialLaneSufficiency: typeof payload?.meta?.initialLaneSufficiency === "string" ? payload.meta.initialLaneSufficiency : null,
    finalLaneSufficiency: typeof payload?.meta?.finalLaneSufficiency === "string" ? payload.meta.finalLaneSufficiency : null,
    subjectMatch: typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null,
    sufficiency: typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null
  };
}

export async function runAndWriteFullStandardPressureReviewBenchmark(): Promise<{
  readonly report: FullStandardPressureReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const runtime = buildBenchmarkRuntimeMetadata({
    benchmarkMode: "sampled",
    sampleControls: {
      suite: "full_standard_pressure_review",
      scenarioCount: SCENARIOS.length
    }
  });
  const raw = await downloadCached(
    "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    "locomo10.json"
  );
  const dataset = JSON.parse(raw) as readonly LocomoConversation[];
  const sampleMap = new Map(dataset.map((sample) => [sample.sample_id, sample]));
  const scenarioGroups = new Map<string, PressureScenarioDefinition[]>();
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

  const results: PressureScenarioResult[] = [];
  const namespacesToCleanup: string[] = [];

  try {
    for (const [sampleId, sampleScenarios] of scenarioGroups.entries()) {
      const sample = sampleMap.get(sampleId);
      if (!sample) {
        throw new Error(`Missing LoCoMo sample ${sampleId}`);
      }
      const namespaceId = `benchmark_pressure_${stamp}_${sample.sample_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      namespacesToCleanup.push(namespaceId);
      const sampleRoot = path.join(generatedRoot(), namespaceId);
      await mkdir(sampleRoot, { recursive: true });
      const sessionEntries = Object.entries(sample.conversation).filter(
        ([key, value]) => key.startsWith("session_") && Array.isArray(value)
      ) as Array<[string, readonly TurnRecord[]]>;

      for (const [sessionKey, turns] of sessionEntries) {
        const sessionPath = path.join(sampleRoot, `${sample.sample_id}-${sessionKey}.md`);
        const sessionDateTime =
          typeof sample.conversation[`${sessionKey}_date_time`] === "string"
            ? parseLoCoMoSessionDateTimeToIso(sample.conversation[`${sessionKey}_date_time`] as string)
            : null;
        await writeFile(sessionPath, formatConversationSession(sample, sessionKey, turns), "utf8");
        await ingestArtifact({
          namespaceId,
          sourceType: "markdown",
          inputUri: sessionPath,
          capturedAt: sessionDateTime ?? new Date().toISOString(),
          metadata: {
            benchmark: "full_standard_pressure_review",
            sample_id: sample.sample_id,
            session_key: sessionKey
          },
          sourceChannel: "benchmark:full_standard_pressure_review"
        });
      }

      await rebuildTypedMemoryNamespace(namespaceId);

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

    const report: FullStandardPressureReviewReport = {
      generatedAt,
      runtime,
      scenarioCount: results.length,
      families,
      scenarios: results
    };

    const jsonPath = path.join(outputDir(), `full-standard-pressure-review-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `full-standard-pressure-review-${stamp}.md`);
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

export async function runFullStandardPressureReviewBenchmarkCli(): Promise<void> {
  try {
    const { output, report } = await runAndWriteFullStandardPressureReviewBenchmark();
    process.stdout.write(`${JSON.stringify({ passFamilies: report.families, output }, null, 2)}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}
