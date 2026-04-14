import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

interface ArtifactScenario {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly failureClass: string;
}

interface CanonicalFamilyScenarioResult {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly failureClass: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly latencyMs: number;
  readonly answerSnippet: string | null;
  readonly dominantStage: string | null;
  readonly finalClaimSource: string | null;
  readonly canonicalPathUsed: boolean;
  readonly canonicalPredicateFamily: string | null;
  readonly canonicalSupportStrength: string | null;
  readonly canonicalAbstainReason: string | null;
}

export interface LoCoMoCanonicalFamilyReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sourceArtifactPath: string;
  readonly scenarioCount: number;
  readonly normalizedPassRate: number;
  readonly families: Readonly<Record<string, { readonly count: number; readonly normalizedPassRate: number; readonly p50Ms: number; readonly p95Ms: number }>>;
  readonly scenarios: readonly CanonicalFamilyScenarioResult[];
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "locomo-canonical-family-review");
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

async function resolveSourceArtifactPath(): Promise<string> {
  const explicit = process.env.BRAIN_LOCOMO_ARTIFACT_PATH;
  if (explicit) {
    return explicit;
  }
  const files = (await readdir(outputDir()))
    .filter((file) => /^locomo-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file) && !file.includes(".partial"))
    .map((file) => path.join(outputDir(), file));
  const ranked = await Promise.all(files.map(async (filePath) => ({ filePath, stats: await stat(filePath) })));
  ranked.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const fullArtifact = ranked.find((entry) => entry.filePath.endsWith(".json"));
  if (!fullArtifact) {
    throw new Error("No LoCoMo artifact found.");
  }
  return fullArtifact.filePath;
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
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function compactNormalize(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function extractCompactAnswerItems(value: unknown): string[] {
  return [...new Set(String(value ?? "").split(/[,\n;]+/g).map((item) => compactNormalize(item)).filter((item) => item.length > 2))];
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
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedExpected = normalize(expectedAnswer);
  if (!normalizedExpected) {
    return false;
  }
  return candidateTexts.some((candidate) => {
    const normalizedCandidate = normalize(candidate);
    const compactCandidate = compactNormalize(candidate);
    return (
      normalizedCandidate === normalizedExpected ||
      normalizedCandidate.includes(normalizedExpected) ||
      normalizedExpected.includes(normalizedCandidate) ||
      compactListPass(expectedAnswer, compactCandidate)
    );
  });
}

function bestEffortPass(expectedAnswer: string, payload: any): boolean {
  const answer = typeof payload?.duality?.claim?.text === "string" ? payload.duality.claim.text : "";
  return normalize(answer) === normalize(expectedAnswer);
}

function trimSnippet(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function formatConversationSession(sample: LocomoConversation, sessionKey: string, turns: readonly TurnRecord[]): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`, "");
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

async function searchText(url: string): Promise<string> {
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

function selectScenarios(artifactResults: readonly any[]): ArtifactScenario[] {
  const targetFamilies = ["answer_shaping", "alias_entity_resolution", "temporal", "abstention", "synthesis_commonality"];
  const perFamily = Number(process.env.BRAIN_LOCOMO_CANONICAL_REPLAY_PER_FAMILY ?? "4");
  const selected: ArtifactScenario[] = [];
  for (const family of targetFamilies) {
    const familyRows = artifactResults
      .filter((row) => row.normalizedPassed !== true && row.failureClass === family)
      .slice(0, perFamily);
    for (const row of familyRows) {
      selected.push({
        sampleId: row.sampleId,
        questionIndex: row.questionIndex,
        category: row.category,
        question: row.question,
        expectedAnswer: row.expectedAnswer,
        failureClass: row.failureClass
      });
    }
  }
  return selected;
}

async function runScenario(namespaceId: string, scenario: ArtifactScenario): Promise<CanonicalFamilyScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: namespaceId,
    query: scenario.question,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  return {
    sampleId: scenario.sampleId,
    questionIndex: scenario.questionIndex,
    category: scenario.category,
    question: scenario.question,
    expectedAnswer: scenario.expectedAnswer,
    failureClass: scenario.failureClass,
    passed: bestEffortPass(scenario.expectedAnswer, payload),
    normalizedPassed: normalizedAnswerPass(scenario.expectedAnswer, payload),
    latencyMs,
    answerSnippet: trimSnippet(payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.claimText),
    dominantStage: typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : null,
    finalClaimSource: typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null,
    canonicalPathUsed: payload?.meta?.canonicalPathUsed === true,
    canonicalPredicateFamily: typeof payload?.meta?.canonicalPredicateFamily === "string" ? payload.meta.canonicalPredicateFamily : null,
    canonicalSupportStrength: typeof payload?.meta?.canonicalSupportStrength === "string" ? payload.meta.canonicalSupportStrength : null,
    canonicalAbstainReason: typeof payload?.meta?.canonicalAbstainReason === "string" ? payload.meta.canonicalAbstainReason : null
  };
}

function toMarkdown(report: LoCoMoCanonicalFamilyReviewReport): string {
  const lines = [
    "# LoCoMo Canonical Family Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- scenarioCount: ${report.scenarioCount}`,
    `- normalizedPassRate: ${report.normalizedPassRate}`,
    "",
    "## Families",
    ""
  ];
  for (const [family, summary] of Object.entries(report.families)) {
    lines.push(`- ${family}: count=${summary.count} normalizedPassRate=${summary.normalizedPassRate} p50Ms=${summary.p50Ms} p95Ms=${summary.p95Ms}`);
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of report.scenarios) {
    lines.push(`- ${scenario.failureClass} | ${scenario.sampleId}#${scenario.questionIndex} | normalized=${scenario.normalizedPassed ? "pass" : "fail"} | latencyMs=${scenario.latencyMs}`);
    lines.push(`  - q: ${scenario.question}`);
    lines.push(`  - expected: ${scenario.expectedAnswer}`);
    lines.push(`  - answer: ${scenario.answerSnippet ?? "n/a"}`);
    lines.push(`  - dominantStage: ${scenario.dominantStage ?? "n/a"}`);
    lines.push(`  - finalClaimSource: ${scenario.finalClaimSource ?? "n/a"}`);
    lines.push(`  - canonicalPathUsed: ${scenario.canonicalPathUsed ? "true" : "false"}`);
    if (scenario.canonicalPredicateFamily) {
      lines.push(`  - canonicalPredicateFamily: ${scenario.canonicalPredicateFamily}`);
    }
    if (scenario.canonicalSupportStrength) {
      lines.push(`  - canonicalSupportStrength: ${scenario.canonicalSupportStrength}`);
    }
    if (scenario.canonicalAbstainReason) {
      lines.push(`  - canonicalAbstainReason: ${scenario.canonicalAbstainReason}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoCanonicalFamilyReview(): Promise<{
  readonly report: LoCoMoCanonicalFamilyReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const sourceArtifactPath = await resolveSourceArtifactPath();
  const artifact = JSON.parse(await readFile(sourceArtifactPath, "utf8")) as { readonly results: readonly any[] };
  const scenarios = selectScenarios(artifact.results);
  const runtime = buildBenchmarkRuntimeMetadata({
    benchmarkMode: "sampled",
    sampleControls: {
      suite: "locomo_canonical_family_review",
      scenarioCount: scenarios.length
    }
  });

  const raw = await downloadCached("https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json", "locomo10.json");
  const parsed = JSON.parse(raw) as readonly LocomoConversation[];
  const bySampleId = new Map(parsed.map((sample) => [sample.sample_id, sample]));
  const results: CanonicalFamilyScenarioResult[] = [];

  for (const scenario of scenarios) {
    const sample = bySampleId.get(scenario.sampleId);
    if (!sample) {
      continue;
    }
    const namespaceId = `benchmark_locomo_canonical_${stamp}_${sample.sample_id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    try {
      for (const sessionKey of ["conversation_1", "conversation_2"] as const) {
        const turns = sample.conversation[sessionKey];
        if (!Array.isArray(turns) || turns.length === 0) {
          continue;
        }
        const rawText = formatConversationSession(sample, sessionKey, turns);
        await ingestArtifact({
          namespaceId,
          sourceType: "markdown_session",
          inputUri: `benchmark://${sample.sample_id}/${sessionKey}`,
          capturedAt: new Date().toISOString(),
          rawText,
          metadata: { benchmark: "locomo_canonical_family_review", sample_id: sample.sample_id, session: sessionKey }
        });
      }
      await rebuildTypedMemoryNamespace(namespaceId);
      results.push(await runScenario(namespaceId, scenario));
    } finally {
      await cleanupPublicBenchmarkNamespaces([namespaceId]);
    }
  }

  const families = Object.fromEntries(
    [...new Set(results.map((result) => result.failureClass))].map((family) => {
      const familyResults = results.filter((result) => result.failureClass === family);
      return [
        family,
        {
          count: familyResults.length,
          normalizedPassRate: Number((familyResults.filter((result) => result.normalizedPassed).length / Math.max(1, familyResults.length)).toFixed(3)),
          p50Ms: percentile(familyResults.map((result) => result.latencyMs), 50),
          p95Ms: percentile(familyResults.map((result) => result.latencyMs), 95)
        }
      ];
    })
  );

  const report: LoCoMoCanonicalFamilyReviewReport = {
    generatedAt,
    runtime,
    sourceArtifactPath,
    scenarioCount: results.length,
    normalizedPassRate: Number((results.filter((result) => result.normalizedPassed).length / Math.max(1, results.length)).toFixed(3)),
    families,
    scenarios: results
  };

  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `locomo-canonical-family-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `locomo-canonical-family-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLoCoMoCanonicalFamilyReviewCli(): Promise<void> {
  try {
    const result = await runAndWriteLoCoMoCanonicalFamilyReview();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
