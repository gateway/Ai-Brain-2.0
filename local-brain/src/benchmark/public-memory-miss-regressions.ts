import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface LongMemEvalEntry {
  readonly question_id: string;
  readonly question: string;
  readonly answer: string;
  readonly question_type: string;
  readonly haystack_sessions: readonly (readonly { readonly role: string; readonly content: string }[])[];
  readonly haystack_dates?: readonly string[];
}

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
    readonly answer: string;
    readonly category: number;
  }[];
}

type Confidence = "confident" | "weak" | "missing";

interface Scenario {
  readonly name: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: Confidence;
  readonly minimumEvidence: number;
}

interface ScenarioResult {
  readonly name: string;
  readonly latencyMs: number;
  readonly confidence: Confidence | null;
  readonly sufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface PublicMemoryMissRegressionsReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly datasetFiles: {
    readonly longMemEvalRawPath: string;
    readonly loCoMoRawPath: string;
  };
  readonly namespaces: readonly string[];
  readonly results: readonly ScenarioResult[];
  readonly passed: boolean;
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-miss-regressions");
}

function rawDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare", "raw");
}

function evidenceItems(payload: any): readonly any[] {
  return Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
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

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function formatSession(turns: readonly { readonly role: string; readonly content: string }[], date: string | undefined): string {
  const lines: string[] = [];
  if (date) {
    lines.push(`[${date}]`);
  }
  for (const turn of turns) {
    lines.push(`${turn.role}: ${turn.content}`);
  }
  return lines.join("\n");
}

function formatConversationSession(sample: LocomoConversation, sessionKey: string, turns: readonly TurnRecord[]): string {
  const dateTime = typeof sample.conversation[`${sessionKey}_date_time`] === "string" ? sample.conversation[`${sessionKey}_date_time`] : "";
  const canonicalCapturedAt = typeof dateTime === "string" && dateTime ? parseLoCoMoSessionDateTimeToIso(dateTime) : null;
  const speakerA = typeof sample.conversation.speaker_a === "string" ? sample.conversation.speaker_a : "Speaker A";
  const speakerB = typeof sample.conversation.speaker_b === "string" ? sample.conversation.speaker_b : "Speaker B";
  const lines: string[] = [];
  if (canonicalCapturedAt) {
    lines.push(`Captured: ${canonicalCapturedAt}`);
    lines.push("");
  } else if (dateTime) {
    lines.push(`Captured: ${dateTime}`);
    lines.push("");
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

async function loadLongMemEvalEntry(questionId: string): Promise<LongMemEvalEntry> {
  const parsed = JSON.parse(await readFile(path.join(rawDir(), "longmemeval_s_cleaned.json"), "utf8")) as readonly LongMemEvalEntry[];
  const entry = parsed.find((item) => item.question_id === questionId);
  if (!entry) {
    throw new Error(`LongMemEval entry ${questionId} not found.`);
  }
  return entry;
}

async function loadLoCoMoConversation(sampleId: string): Promise<LocomoConversation> {
  const parsed = JSON.parse(await readFile(path.join(rawDir(), "locomo10.json"), "utf8")) as readonly LocomoConversation[];
  const entry = parsed.find((item) => item.sample_id === sampleId);
  if (!entry) {
    throw new Error(`LoCoMo sample ${sampleId} not found.`);
  }
  return entry;
}

async function ingestLongMemEvalEntry(namespaceId: string, entry: LongMemEvalEntry): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  for (const [sessionIndex, session] of entry.haystack_sessions.entries()) {
    const sessionPath = path.join(corpusRoot, `${entry.question_id}-session-${sessionIndex + 1}.md`);
    await writeFile(sessionPath, formatSession(session, entry.haystack_dates?.[sessionIndex]), "utf8");
    await ingestArtifact({
      namespaceId,
      sourceType: "markdown",
      inputUri: sessionPath,
      capturedAt: entry.haystack_dates?.[sessionIndex] ?? new Date().toISOString(),
      metadata: {
        benchmark: "public_memory_miss_regressions",
        source_dataset: "longmemeval",
        question_id: entry.question_id
      },
      sourceChannel: "benchmark:public_memory_miss_regressions"
    });
  }
}

async function ingestLoCoMoConversation(namespaceId: string, sample: LocomoConversation): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  const sessionEntries = Object.entries(sample.conversation).filter(
    ([key, value]) => key.startsWith("session_") && Array.isArray(value)
  ) as Array<[string, readonly TurnRecord[]]>;

  for (const [sessionKey, turns] of sessionEntries) {
    const sessionPath = path.join(corpusRoot, `${sample.sample_id}-${sessionKey}.md`);
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
        benchmark: "public_memory_miss_regressions",
        source_dataset: "locomo",
        sample_id: sample.sample_id,
        session_key: sessionKey
      },
      sourceChannel: "benchmark:public_memory_miss_regressions"
    });
  }
}

function scenarios(namespaces: {
  readonly longMemCommute: string;
  readonly longMemPlay: string;
  readonly locomo: string;
}): readonly Scenario[] {
  return [
    {
      name: "longmemeval_commute_duration",
      namespaceId: namespaces.longMemCommute,
      query: "How long is my daily commute to work?",
      expectedTerms: ["45 minutes each way"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "longmemeval_play_title",
      namespaceId: namespaces.longMemPlay,
      query: "What play did I attend at the local community theater?",
      expectedTerms: ["The Glass Menagerie"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_support_group_exact_date",
      namespaceId: namespaces.locomo,
      query: "When did Caroline go to the LGBTQ support group?",
      expectedTerms: ["7 May 2023"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_sunrise_year",
      namespaceId: namespaces.locomo,
      query: "When did Melanie paint a sunrise?",
      expectedTerms: ["2022"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_jon_job_loss_date",
      namespaceId: namespaces.locomo,
      query: "When Jon has lost his job as a banker?",
      expectedTerms: ["19 January 2023"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_gina_job_loss_month",
      namespaceId: namespaces.locomo,
      query: "When Gina has lost her job at Door Dash?",
      expectedTerms: ["January 2023"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_career_profile_inference",
      namespaceId: namespaces.locomo,
      query: "What fields would Caroline be likely to pursue in her educaton?",
      expectedTerms: ["psychology", "counseling"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_identity_profile",
      namespaceId: namespaces.locomo,
      query: "What is Caroline's identity?",
      expectedTerms: ["transgender woman"],
      expectedConfidence: "confident",
      minimumEvidence: 1
    },
    {
      name: "locomo_shared_destress",
      namespaceId: namespaces.locomo,
      query: "How do Jon and Gina both like to destress?",
      expectedTerms: ["dancing"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "locomo_shared_commonality",
      namespaceId: namespaces.locomo,
      query: "What do Jon and Gina both have in common?",
      expectedTerms: ["lost their jobs", "start their own businesses"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "locomo_causal_motive",
      namespaceId: namespaces.locomo,
      query: "Why did Jon decide to start his dance studio?",
      expectedTerms: ["lost his job", "passion for dance", "share"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    }
  ];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidence = evidenceItems(payload);
  const confidence = typeof payload?.duality?.confidence === "string" ? (payload.duality.confidence as Confidence) : null;
  const sufficiency = typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null;
  const subjectMatch = typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null;
  const failures: string[] = [];

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

  if (sourceLinkCount(evidence) < scenario.minimumEvidence) {
    failures.push("expected source links for benchmark evidence");
  }

  return {
    name: scenario.name,
    latencyMs,
    confidence,
    sufficiency,
    subjectMatch,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    passed: failures.length === 0,
    failures
  };
}

function toMarkdown(report: PublicMemoryMissRegressionsReport): string {
  const lines = [
    "# Public Memory Miss Regressions",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- iterativeScanMode: ${report.runtime.iterativeScanMode}`,
    `- longMemEvalRawPath: ${report.datasetFiles.longMemEvalRawPath}`,
    `- loCoMoRawPath: ${report.datasetFiles.loCoMoRawPath}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];

  for (const result of report.results) {
    lines.push(
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | sufficiency=${result.sufficiency ?? "n/a"} | subjectMatch=${result.subjectMatch ?? "n/a"} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount} | latencyMs=${result.latencyMs}`
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWritePublicMemoryMissRegressionsBenchmark(): Promise<{
  readonly report: PublicMemoryMissRegressionsReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const namespaces = {
    longMemCommute: `benchmark_public_miss_commute_${stamp}`,
    longMemPlay: `benchmark_public_miss_play_${stamp}`,
    locomo: `benchmark_public_miss_locomo_${stamp}`
  } as const;

  await ingestLongMemEvalEntry(namespaces.longMemCommute, await loadLongMemEvalEntry("118b2229"));
  await ingestLongMemEvalEntry(namespaces.longMemPlay, await loadLongMemEvalEntry("58bf7951"));
  await ingestLoCoMoConversation(namespaces.locomo, await loadLoCoMoConversation("conv-26"));
  await ingestLoCoMoConversation(namespaces.locomo, await loadLoCoMoConversation("conv-30"));

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios(namespaces)) {
    results.push(await runScenario(scenario));
  }

  const report: PublicMemoryMissRegressionsReport = {
    generatedAt,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length,
        includesLongMemEval: true,
        includesLoCoMo: true
      }
    }),
    datasetFiles: {
      longMemEvalRawPath: path.join(rawDir(), "longmemeval_s_cleaned.json"),
      loCoMoRawPath: path.join(rawDir(), "locomo10.json")
    },
    namespaces: Object.values(namespaces),
    results,
    passed: results.every((result) => result.passed)
  };

  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `public-memory-miss-regressions-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `public-memory-miss-regressions-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runPublicMemoryMissRegressionsBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWritePublicMemoryMissRegressionsBenchmark();
  process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
