import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { parseLoCoMoSessionDateTimeToIso } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface TurnRecord {
  readonly speaker: string;
  readonly text?: string;
  readonly blip_caption?: string;
}

interface LocomoConversation {
  readonly sample_id: string;
  readonly conversation: Record<string, string | readonly TurnRecord[]>;
}

type Confidence = "confident" | "weak" | "missing";
type Verdict = "pass" | "warning" | "fail";

interface ScenarioDefinition {
  readonly name: string;
  readonly query: string;
  readonly namespaceId: string;
  readonly description: string;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: Confidence;
  readonly minimumEvidence: number;
}

interface ReviewEvidenceRow {
  readonly memoryId?: string;
  readonly memoryType?: string;
  readonly artifactId?: string;
  readonly occurredAt?: string;
  readonly sourceUri?: string;
  readonly snippet?: string;
}

interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: string | null;
  readonly evidence: readonly ReviewEvidenceRow[];
  readonly sourcePaths: readonly string[];
  readonly answerSnippet: string | null;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

export interface SharedCausalReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly datasetFiles: {
    readonly loCoMoRawPath: string;
  };
  readonly namespaces: readonly string[];
  readonly scenarios: readonly ScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
  };
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "shared-causal-review");
}

function rawDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare", "raw");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null).toLowerCase();
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).includes(term.toLowerCase());
}

function trimSnippet(value: unknown, max = 220): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function toEvidenceRows(payload: any): readonly ReviewEvidenceRow[] {
  const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
  return evidence.slice(0, 8).map((item: any) => ({
    memoryId: typeof item?.memoryId === "string" ? item.memoryId : undefined,
    memoryType: typeof item?.memoryType === "string" ? item.memoryType : undefined,
    artifactId: typeof item?.artifactId === "string" ? item.artifactId : undefined,
    occurredAt: typeof item?.occurredAt === "string" ? item.occurredAt : undefined,
    sourceUri: typeof item?.sourceUri === "string" ? item.sourceUri : undefined,
    snippet: trimSnippet(item?.snippet)
  }));
}

function extractSourcePaths(evidence: readonly ReviewEvidenceRow[]): readonly string[] {
  return [...new Set(evidence.map((row) => row.sourceUri).filter((value): value is string => typeof value === "string" && value.length > 0))];
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
  }
  return lines.join("\n");
}

async function loadLoCoMoConversation(sampleId: string): Promise<LocomoConversation> {
  const parsed = JSON.parse(await readFile(path.join(rawDir(), "locomo10.json"), "utf8")) as readonly LocomoConversation[];
  const entry = parsed.find((item) => item.sample_id === sampleId);
  if (!entry) {
    throw new Error(`LoCoMo sample ${sampleId} not found.`);
  }
  return entry;
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
        benchmark: "shared_causal_review",
        source_dataset: "locomo",
        sample_id: sample.sample_id,
        session_key: sessionKey
      },
      sourceChannel: "benchmark:shared_causal_review"
    });
  }
}

async function ingestSyntheticMarkdown(namespaceId: string, name: string, body: string, capturedAt: string): Promise<void> {
  const corpusRoot = path.join(generatedRoot(), namespaceId);
  await mkdir(corpusRoot, { recursive: true });
  const filePath = path.join(corpusRoot, `${name}.md`);
  await writeFile(filePath, body, "utf8");
  await ingestArtifact({
    namespaceId,
    sourceType: "markdown",
    inputUri: filePath,
    capturedAt,
    metadata: {
      benchmark: "shared_causal_review",
      source_dataset: "synthetic",
      scenario: name
    },
    sourceChannel: "benchmark:shared_causal_review"
  });
}

function toMarkdown(report: SharedCausalReviewReport): string {
  const lines = [
    "# Shared And Causal Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- loCoMoRawPath: ${report.datasetFiles.loCoMoRawPath}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(`- ${scenario.name}: ${scenario.verdict} | confidence=${scenario.confidence ?? "n/a"} | latencyMs=${scenario.latencyMs}`);
    lines.push(`  - q: ${scenario.query}`);
    if (scenario.answerSnippet) {
      lines.push(`  - answer: ${scenario.answerSnippet}`);
    }
    if (scenario.sourcePaths.length > 0) {
      lines.push(`  - sources: ${scenario.sourcePaths.join(" | ")}`);
    }
    for (const failure of scenario.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runScenario(definition: ScenarioDefinition): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: definition.namespaceId,
    query: definition.query,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidence = toEvidenceRows(payload);
  const confidence = typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null;
  const failures: string[] = [];

  for (const term of definition.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }
  if (confidence !== definition.expectedConfidence) {
    failures.push(`expected confidence ${definition.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }
  if (evidence.length < definition.minimumEvidence) {
    failures.push(`expected at least ${definition.minimumEvidence} evidence rows, got ${evidence.length}`);
  }
  const sourcePaths = extractSourcePaths(evidence);
  if (sourcePaths.length < definition.minimumEvidence) {
    failures.push("expected source-backed evidence");
  }

  const verdict: Verdict = failures.length === 0 ? "pass" : confidence === "missing" || confidence === "weak" ? "warning" : "fail";
  return {
    name: definition.name,
    description: definition.description,
    namespaceId: definition.namespaceId,
    query: definition.query,
    latencyMs,
    confidence,
    evidence,
    sourcePaths,
    answerSnippet: trimSnippet(payload?.duality?.claim?.text ?? payload?.summaryText ?? payload?.explanation) ?? null,
    verdict,
    failures
  };
}

export async function runAndWriteSharedCausalReviewBenchmark(): Promise<{
  readonly report: SharedCausalReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const namespaces = {
    publicLocomo: `benchmark_shared_causal_public_${stamp}`,
    syntheticShared: `benchmark_shared_causal_synth_shared_${stamp}`,
    syntheticCausal: `benchmark_shared_causal_synth_causal_${stamp}`,
    syntheticGuardrail: `benchmark_shared_causal_synth_guardrail_${stamp}`
  } as const;

  await ingestLoCoMoConversation(namespaces.publicLocomo, await loadLoCoMoConversation("conv-30"));
  await ingestSyntheticMarkdown(
    namespaces.syntheticShared,
    "shared_hobby_overlap_maya",
    [
      "2026-03-20",
      "Maya: After work I climb because it clears my head.",
      "Maya: Sketching on weekends helps too."
    ].join("\n"),
    "2026-03-20T11:00:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.syntheticCausal,
    "causal_project_shift_a",
    [
      "2026-03-21",
      "Project Atlas changed direction after repeated sync failures in low-connectivity environments."
    ].join("\n"),
    "2026-03-21T09:30:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.syntheticShared,
    "shared_hobby_overlap_leo",
    [
      "2026-03-20",
      "Leo: Climbing is how I destress after stressful client calls.",
      "Leo: I sketch on weekends when I need a quieter reset."
    ].join("\n"),
    "2026-03-20T18:00:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.syntheticCausal,
    "causal_project_shift_b",
    [
      "2026-03-21",
      "Steve decided to move Atlas toward offline-first capture after the field pilot setbacks.",
      "The goal was to prevent data loss and reduce operator frustration during remote use."
    ].join("\n"),
    "2026-03-21T12:45:00.000Z"
  );
  await ingestSyntheticMarkdown(
    namespaces.syntheticGuardrail,
    "partial_overlap_guardrail",
    [
      "2026-03-18",
      "Nina relaxes by doing yoga and cooking.",
      "Omar relaxes by playing chess and reading science fiction."
    ].join("\n"),
    "2026-03-18T08:15:00.000Z"
  );

  const definitions: readonly ScenarioDefinition[] = [
    {
      name: "public_locomo_shared_destress",
      namespaceId: namespaces.publicLocomo,
      query: "How do Jon and Gina both like to destress?",
      description: "Public benchmark shared-behavior recall should stay grounded.",
      expectedTerms: ["dancing"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "public_locomo_causal_motive",
      namespaceId: namespaces.publicLocomo,
      query: "Why did Jon decide to start his dance studio?",
      description: "Public benchmark causal motive synthesis should cite trigger and motive.",
      expectedTerms: ["losing my job", "passion", "share"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "synthetic_shared_overlap",
      namespaceId: namespaces.syntheticShared,
      query: "What do Maya and Leo both do to destress?",
      description: "Synthetic shared overlap should work outside benchmark-specific names.",
      expectedTerms: ["climb"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "synthetic_causal_project_shift",
      namespaceId: namespaces.syntheticCausal,
      query: "Why did Project Atlas change direction?",
      description: "Synthetic project rationale should join trigger, decision, and goal.",
      expectedTerms: ["sync failures", "offline first", "prevent data loss"],
      expectedConfidence: "confident",
      minimumEvidence: 2
    },
    {
      name: "synthetic_partial_overlap_guardrail",
      namespaceId: namespaces.syntheticGuardrail,
      query: "What do Nina and Omar both do to relax?",
      description: "Guardrail case should avoid inventing overlap when there is none.",
      expectedTerms: [],
      expectedConfidence: "missing",
      minimumEvidence: 0
    }
  ];

  const scenarios: ScenarioResult[] = [];
  for (const definition of definitions) {
    scenarios.push(await runScenario(definition));
  }

  const summary = {
    pass: scenarios.filter((scenario) => scenario.verdict === "pass").length,
    warning: scenarios.filter((scenario) => scenario.verdict === "warning").length,
    fail: scenarios.filter((scenario) => scenario.verdict === "fail").length
  };

  const report: SharedCausalReviewReport = {
    generatedAt,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: definitions.length,
        includesPublicLocomo: true,
        includesSynthetic: true
      }
    }),
    datasetFiles: {
      loCoMoRawPath: path.join(rawDir(), "locomo10.json")
    },
    namespaces: Object.values(namespaces),
    scenarios,
    summary
  };

  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `shared-causal-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `shared-causal-review-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runSharedCausalReviewBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteSharedCausalReviewBenchmark();
  process.stdout.write(`${JSON.stringify({ summary: report.summary, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2)}\n`);
  await closePool();
}
