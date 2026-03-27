import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { withMaintenanceLock } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { executeMcpTool } from "../mcp/server.js";
import { cleanupPublicBenchmarkNamespaces } from "./public-benchmark-cleanup.js";
import { normalizeBenchmarkCapturedAt } from "./public-memory-date-utils.js";
import { buildBenchmarkRuntimeMetadata, resolvePublicBenchmarkMode, resolveRequestedSampleCount, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface LongMemEvalEntry {
  readonly question_id: string;
  readonly question: string;
  readonly answer: string;
  readonly question_type: string;
  readonly haystack_sessions: readonly (readonly { readonly role: string; readonly content: string }[])[];
  readonly haystack_dates?: readonly string[];
}

type FailureClass =
  | "pass"
  | "retrieval"
  | "temporal"
  | "provenance"
  | "answer_shaping"
  | "synthesis_commonality"
  | "conflict_resolution"
  | "alias_entity_resolution"
  | "abstention";

type SufficiencyGrade = "supported" | "weak" | "missing" | "contradicted" | null;
type SubjectMatch = "matched" | "mixed" | "mismatched" | "unknown" | null;
type SynthesisMode = "recall" | "reflect" | null;

interface QueryResult {
  readonly questionId: string;
  readonly questionType: string;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly failureClass: FailureClass;
  readonly confidence: string | null;
  readonly sufficiency: SufficiencyGrade;
  readonly subjectMatch: SubjectMatch;
  readonly synthesisMode: SynthesisMode;
  readonly globalQueryRouted: boolean;
  readonly summaryRoutingUsed: boolean;
  readonly latencyMs: number;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string;
}

export interface LongMemEvalReport {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
  };
  readonly diagnostics: {
    readonly failureBreakdown: Readonly<Record<FailureClass, number>>;
    readonly sufficiencyBreakdown: Readonly<Record<Exclude<SufficiencyGrade, null>, number>>;
    readonly subjectMatchBreakdown: Readonly<Record<Exclude<SubjectMatch, null>, number>>;
    readonly synthesisModeBreakdown: Readonly<Record<Exclude<SynthesisMode, null>, number>>;
  };
  readonly results: readonly QueryResult[];
  readonly passed: boolean;
}

function shouldSkipPublicBenchmarkCleanup(): boolean {
  return process.env.BRAIN_PUBLIC_BENCHMARK_SKIP_CLEANUP === "1";
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
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-memory-compare");
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function toMarkdown(report: LongMemEvalReport): string {
  const lines = [
    "# LongMemEval Compatibility Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- dataset: ${report.dataset}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- fastScorerVersion: ${report.runtime.fastScorerVersion}`,
    `- officialishScorerVersion: ${report.runtime.officialishScorerVersion}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passRate: ${report.passRate}`,
    `- passed: ${report.passed}`,
    `- latency.p50Ms: ${report.latency.p50Ms}`,
    `- latency.p95Ms: ${report.latency.p95Ms}`,
    "",
    "## Diagnostics",
    "",
    `- failureBreakdown: ${JSON.stringify(report.diagnostics.failureBreakdown)}`,
    `- sufficiencyBreakdown: ${JSON.stringify(report.diagnostics.sufficiencyBreakdown)}`,
    `- subjectMatchBreakdown: ${JSON.stringify(report.diagnostics.subjectMatchBreakdown)}`,
    `- synthesisModeBreakdown: ${JSON.stringify(report.diagnostics.synthesisModeBreakdown)}`,
    "",
    "## Results",
    ""
  ];
    for (const result of report.results) {
    lines.push(
      `- ${result.questionId} (${result.questionType}): ${result.passed ? "pass" : "fail"} | normalized=${result.normalizedPassed ? "pass" : "fail"} | confidence=${result.confidence ?? "n/a"} | latency=${result.latencyMs} | evidence=${result.evidenceCount} | sources=${result.sourceCount}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function downloadText(url: string, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const location = response.headers.location;
      if (
        location &&
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400
      ) {
        if (redirectCount >= 5) {
          reject(new Error(`too many redirects while fetching ${url}`));
          response.resume();
          return;
        }
        response.resume();
        const nextUrl = new URL(location, url).toString();
        downloadText(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
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
  const looksLikeJson = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  };
  try {
    const cached = await readFile(destination, "utf8");
    if (looksLikeJson(cached)) {
      return cached;
    }
  } catch {
    // fall through to fresh download
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const body = await downloadText(url);
  await writeFile(destination, body, "utf8");
  return body;
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

function bestEffortPass(expectedAnswer: string, payload: any): boolean {
  const haystack = normalize(JSON.stringify(payload));
  const expected = normalize(expectedAnswer);
  if (!expected) {
    return false;
  }
  if (haystack.includes(expected)) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  const hitCount = expectedTokens.filter((token) => haystack.includes(token)).length;
  return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.6;
}

function normalizedAnswerPass(expectedAnswer: string, payload: any): boolean {
  const candidates = [
    payload?.duality?.claim?.text,
    payload?.summaryText,
    payload?.claimText,
    payload?.explanation,
    ...(Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.map((item: any) => item?.snippet) : [])
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => normalize(item));
  const expected = normalize(expectedAnswer);
  if (!expected || candidates.length === 0) {
    return false;
  }
  if (candidates.some((candidate) => candidate.includes(expected))) {
    return true;
  }
  const expectedTokens = expected.split(" ").filter((token) => token.length > 2);
  return candidates.some((candidate) => {
    const hitCount = expectedTokens.filter((token) => candidate.includes(token)).length;
    return expectedTokens.length > 0 && hitCount / expectedTokens.length >= 0.75;
  });
}

function classifyFailure(
  entry: LongMemEvalEntry,
  passed: boolean,
  sufficiency: SufficiencyGrade,
  subjectMatch: SubjectMatch,
  evidenceCount: number,
  sourceCount: number
): FailureClass {
  if (passed) {
    return "pass";
  }
  if (subjectMatch === "mismatched" || subjectMatch === "mixed") {
    return "alias_entity_resolution";
  }
  if (sourceCount === 0 && evidenceCount > 0) {
    return "provenance";
  }
  if (sufficiency === "missing" || sufficiency === "contradicted") {
    return "abstention";
  }
  if (evidenceCount === 0) {
    return entry.question_type.toLowerCase().includes("time") ? "temporal" : "retrieval";
  }
  const questionText = entry.question.toLowerCase();
  const questionType = entry.question_type.toLowerCase();
  if (questionType.includes("time") || questionText.includes("before") || questionText.includes("after")) {
    return "temporal";
  }
  if (
    /\b(both|common|share|together|similar|difference|compare)\b/.test(questionText) ||
    questionType.includes("multi")
  ) {
    return "synthesis_commonality";
  }
  if (/\b(current|currently|now|still|latest|changed|switch|moved|former|previous)\b/.test(questionText)) {
    return "conflict_resolution";
  }
  return "answer_shaping";
}

function countBy<T extends string>(values: readonly (T | null | undefined)[], expected: readonly T[]): Readonly<Record<T, number>> {
  const counts = Object.fromEntries(expected.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) {
    if (value && value in counts) {
      counts[value] += 1;
    }
  }
  return counts;
}

async function cleanupBenchmarkNamespaces(namespaceIds: readonly string[]): Promise<void> {
  await cleanupPublicBenchmarkNamespaces(namespaceIds);
}

export async function runAndWriteLongMemEvalBenchmark(): Promise<{
  readonly report: LongMemEvalReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  return withMaintenanceLock("the LongMemEval compatibility benchmark", async () => {
    const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const raw = await downloadCached(
      "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
      "longmemeval_s_cleaned.json"
    );
    const parsed = JSON.parse(raw) as readonly LongMemEvalEntry[];
    const sampleCount = resolveRequestedSampleCount(process.env.BRAIN_LONGMEMEVAL_SAMPLE_COUNT, 8, parsed.length);
    const namespaceBatchSize = resolveRequestedSampleCount(process.env.BRAIN_LONGMEMEVAL_NAMESPACE_BATCH_SIZE, 25, sampleCount);
    const skipCleanup = shouldSkipPublicBenchmarkCleanup();
    const entries = parsed.slice(0, sampleCount);
    const results: QueryResult[] = [];
    const latencies: number[] = [];
    const activeNamespaceIds: string[] = [];
    const corpusRoot = path.join(generatedRoot(), "longmemeval");
    await mkdir(corpusRoot, { recursive: true });

    for (const [index, entry] of entries.entries()) {
      const namespaceId = `benchmark_longmemeval_${runStamp}_${index}`;
      for (const [sessionIndex, session] of entry.haystack_sessions.entries()) {
        const sessionPath = path.join(corpusRoot, `${entry.question_id}-session-${sessionIndex + 1}.md`);
        const fallbackCapturedAt = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0) + index * 60_000 + sessionIndex * 1_000).toISOString();
        await writeFile(sessionPath, formatSession(session, entry.haystack_dates?.[sessionIndex]), "utf8");
        await ingestArtifact({
          namespaceId,
          sourceType: "markdown",
          inputUri: sessionPath,
          capturedAt: normalizeBenchmarkCapturedAt(entry.haystack_dates?.[sessionIndex], fallbackCapturedAt),
          metadata: {
            benchmark: "longmemeval",
            question_id: entry.question_id,
            question_type: entry.question_type
          },
          sourceChannel: "benchmark:longmemeval"
        });
      }

      const startedAt = performance.now();
      const wrapped = (await executeMcpTool("memory.search", {
        namespace_id: namespaceId,
        query: entry.question,
        limit: 8
      })) as { readonly structuredContent?: unknown };
      const latencyMs = Number((performance.now() - startedAt).toFixed(2));
      latencies.push(latencyMs);
      const payload = wrapped.structuredContent as any;
      const evidence = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence : [];
      const answerAssessment = payload?.meta?.answerAssessment ?? payload?.answerAssessment ?? null;
      const sourceCount = evidence.filter(
        (item: any) => typeof item?.artifactId === "string" || typeof item?.sourceUri === "string"
      ).length;
      const passed = bestEffortPass(entry.answer, payload);
      const normalizedPassed = normalizedAnswerPass(entry.answer, payload);
      const sufficiency =
        typeof answerAssessment?.sufficiency === "string" ? (answerAssessment.sufficiency as SufficiencyGrade) : null;
      const subjectMatch =
        typeof answerAssessment?.subjectMatch === "string" ? (answerAssessment.subjectMatch as SubjectMatch) : null;
      const synthesisMode =
        typeof payload?.meta?.synthesisMode === "string" ? (payload.meta.synthesisMode as SynthesisMode) : null;

      results.push({
        questionId: entry.question_id,
        questionType: entry.question_type,
        question: entry.question,
        expectedAnswer: entry.answer,
        passed,
        normalizedPassed,
        failureClass: classifyFailure(entry, passed, sufficiency, subjectMatch, evidence.length, sourceCount),
        confidence: typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null,
        sufficiency,
        subjectMatch,
        synthesisMode,
        globalQueryRouted: payload?.meta?.globalQueryRouted === true,
        summaryRoutingUsed: payload?.meta?.summaryRoutingUsed === true,
        latencyMs,
        evidenceCount: evidence.length,
        sourceCount,
        answerSnippet: JSON.stringify(payload?.duality?.claim ?? payload).slice(0, 220)
      });

      activeNamespaceIds.push(namespaceId);
      if (!skipCleanup && activeNamespaceIds.length >= namespaceBatchSize) {
        await cleanupBenchmarkNamespaces(activeNamespaceIds.splice(0, activeNamespaceIds.length));
      }
    }

    if (!skipCleanup && activeNamespaceIds.length > 0) {
      await cleanupBenchmarkNamespaces(activeNamespaceIds.splice(0, activeNamespaceIds.length));
    }

    const passRate = Number((results.filter((result) => result.passed).length / Math.max(1, results.length)).toFixed(3));
    const benchmarkMode = resolvePublicBenchmarkMode(sampleCount, parsed.length);
    const report: LongMemEvalReport = {
      generatedAt: new Date().toISOString(),
      dataset: "longmemeval_s_cleaned",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode,
        sampleControls: {
          requestedSampleCount: process.env.BRAIN_LONGMEMEVAL_SAMPLE_COUNT ?? null,
          resolvedSampleCount: sampleCount,
          totalDatasetCount: parsed.length,
          skipCleanup
        }
      }),
      sampleCount: results.length,
      passRate,
      latency: {
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95)
      },
      diagnostics: {
        failureBreakdown: countBy(
          results.map((result) => result.failureClass),
          [
            "pass",
            "retrieval",
            "temporal",
            "provenance",
            "answer_shaping",
            "synthesis_commonality",
            "conflict_resolution",
            "alias_entity_resolution",
            "abstention"
          ]
        ),
        sufficiencyBreakdown: countBy(results.map((result) => result.sufficiency), ["supported", "weak", "missing", "contradicted"]),
        subjectMatchBreakdown: countBy(results.map((result) => result.subjectMatch), ["matched", "mixed", "mismatched", "unknown"]),
        synthesisModeBreakdown: countBy(results.map((result) => result.synthesisMode), ["recall", "reflect"])
      },
      results,
      passed: passRate >= 0.5
    };

    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    await mkdir(outputDir(), { recursive: true });
    const jsonPath = path.join(outputDir(), `longmemeval-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `longmemeval-${stamp}.md`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return { report, output: { jsonPath, markdownPath } };
  });
}

export async function runLongMemEvalBenchmarkCli(): Promise<void> {
  const { output } = await runAndWriteLongMemEvalBenchmark();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
