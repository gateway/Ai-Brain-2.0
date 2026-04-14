import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface LoCoMoArtifactResult {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly failureClass: string;
  readonly queryBehavior: string;
  readonly latencyMs: number;
  readonly dominantStage?: string | null;
  readonly topStageMs?: number | null;
  readonly finalClaimSource?: string | null;
  readonly reducerFamily?: string | null;
  readonly fallbackSuppressedReason?: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string;
  readonly sufficiency?: string | null;
  readonly subjectMatch?: string | null;
  readonly descentStages?: readonly string[];
}

interface LoCoMoArtifact {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly runtime?: {
    readonly benchmarkMode?: string;
    readonly fastScorerVersion?: string;
    readonly officialishScorerVersion?: string;
  };
  readonly sampleCount: number;
  readonly passRate: number;
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
  };
  readonly results: readonly LoCoMoArtifactResult[];
}

interface ResidualFamilySummary {
  readonly count: number;
  readonly share: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

interface TokenOverlapScore {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

interface ResidualScenario {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly failureClass: string;
  readonly family: string;
  readonly latencyMs: number;
  readonly dominantStage: string | null;
  readonly finalClaimSource: string | null;
  readonly reducerFamily: string | null;
  readonly fallbackSuppressedReason: string | null;
  readonly subjectMatch: string | null;
  readonly sufficiency: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly answerSnippet: string;
}

export interface LoCoMoFullResidualReviewReport {
  readonly generatedAt: string;
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly dataset: string;
  readonly benchmarkMode: string | null;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
  };
  readonly failingCount: number;
  readonly nonEmptyAnswerTokenPrecision: number;
  readonly nonEmptyAnswerTokenRecall: number;
  readonly nonEmptyAnswerTokenF1: number;
  readonly failureBreakdown: Readonly<Record<string, number>>;
  readonly families: Readonly<Record<string, ResidualFamilySummary>>;
  readonly recommendedTracks: readonly string[];
  readonly scenarios: readonly ResidualScenario[];
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

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedTokens(value: unknown): string[] {
  return normalize(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function tokenOverlapScore(expectedAnswer: string, answerSnippet: string): TokenOverlapScore | null {
  const expected = normalize(expectedAnswer);
  if (!expected || expected === "none") {
    return null;
  }
  const expectedTokens = normalizedTokens(expectedAnswer);
  const answerTokens = normalizedTokens(answerSnippet);
  if (expectedTokens.length === 0) {
    return null;
  }
  if (answerTokens.length === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }

  const expectedCounts = new Map<string, number>();
  for (const token of expectedTokens) {
    expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
  }

  let hits = 0;
  for (const token of answerTokens) {
    const remaining = expectedCounts.get(token) ?? 0;
    if (remaining > 0) {
      hits += 1;
      expectedCounts.set(token, remaining - 1);
    }
  }

  const precision = hits / Math.max(1, answerTokens.length);
  const recall = hits / Math.max(1, expectedTokens.length);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    f1: Number(f1.toFixed(3))
  };
}

function classifyResidualFamily(result: LoCoMoArtifactResult): string {
  if (result.failureClass === "answer_shaping") {
    if (result.finalClaimSource === "top_snippet") {
      return "answer_shaping.top_snippet_precedence";
    }
    if (result.finalClaimSource === "fallback_derived") {
      return "answer_shaping.fallback_derived_overreach";
    }
    if (result.reducerFamily === "shared_commonality") {
      return "answer_shaping.shared_commonality";
    }
    return "answer_shaping.other";
  }

  if (result.failureClass === "temporal") {
    if (result.finalClaimSource === "temporal_reducer") {
      return "temporal.canonicalization";
    }
    return "temporal.routing_or_selection";
  }

  if (result.failureClass === "alias_entity_resolution") {
    if (result.subjectMatch === "mixed" || result.subjectMatch === "mismatched") {
      return "alias.subject_binding";
    }
    return "alias.canonical_entity_choice";
  }

  if (result.failureClass === "abstention") {
    return "abstention.guardrail_thresholds";
  }

  if (result.failureClass === "synthesis_commonality") {
    return "commonality.synthesis";
  }

  if (result.failureClass === "conflict_resolution") {
    return "conflict_resolution";
  }

  if (result.failureClass === "retrieval") {
    return "retrieval";
  }

  return result.failureClass;
}

function recommendedTracks(failing: readonly LoCoMoArtifactResult[]): string[] {
  const families = new Set(failing.map(classifyResidualFamily));
  const tracks: string[] = [];
  if (families.has("answer_shaping.top_snippet_precedence") || families.has("answer_shaping.fallback_derived_overreach")) {
    tracks.push("Raise structured family reducers and exact-detail candidates above `top_snippet`/`fallback_derived` in the final claim path.");
  }
  if ([...families].some((family) => family.startsWith("temporal."))) {
    tracks.push("Add full-corpus temporal canonicalizers for month/range/anchored-relative forms instead of defaulting to raw explicit dates.");
  }
  if ([...families].some((family) => family.startsWith("alias."))) {
    tracks.push("Strengthen canonical entity binding before final claim emission, especially for mixed-subject and paired-entity conversations.");
  }
  if (families.has("abstention.guardrail_thresholds")) {
    tracks.push("Tighten abstention thresholds so weak structured evidence does not collapse to incorrect positive claims.");
  }
  if (families.has("commonality.synthesis")) {
    tracks.push("Add bounded commonality reducers for shared-activity and overlap questions instead of relying on reflective synthesis alone.");
  }
  return tracks;
}

async function resolveSourceArtifactPath(): Promise<string> {
  const explicit = process.env.BRAIN_LOCOMO_ARTIFACT_PATH;
  if (explicit) {
    return explicit;
  }

  const files = (await readdir(outputDir()))
    .filter((file) => /^locomo-\d{4}-\d{2}-\d{2}T.*\.json$/u.test(file) && !file.includes(".partial"))
    .map((file) => path.join(outputDir(), file));

  const ranked = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      stats: await stat(filePath)
    }))
  );

  ranked.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const fullArtifact = ranked.find((entry) => entry.filePath.endsWith(".json"));
  if (!fullArtifact) {
    throw new Error("No LoCoMo artifact found.");
  }
  return fullArtifact.filePath;
}

function toMarkdown(report: LoCoMoFullResidualReviewReport): string {
  const lines = [
    "# LoCoMo Full Residual Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourceGeneratedAt: ${report.sourceGeneratedAt}`,
    `- dataset: ${report.dataset}`,
    `- benchmarkMode: ${report.benchmarkMode ?? "n/a"}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passRate: ${report.passRate}`,
    `- latency.p50Ms: ${report.latency.p50Ms}`,
    `- latency.p95Ms: ${report.latency.p95Ms}`,
    `- failingCount: ${report.failingCount}`,
    `- nonEmptyAnswerTokenPrecision: ${report.nonEmptyAnswerTokenPrecision}`,
    `- nonEmptyAnswerTokenRecall: ${report.nonEmptyAnswerTokenRecall}`,
    `- nonEmptyAnswerTokenF1: ${report.nonEmptyAnswerTokenF1}`,
    `- failureBreakdown: ${JSON.stringify(report.failureBreakdown)}`,
    "",
    "## Recommended Tracks",
    ""
  ];

  for (const track of report.recommendedTracks) {
    lines.push(`- ${track}`);
  }

  lines.push("", "## Families", "");
  for (const [family, summary] of Object.entries(report.families)) {
    lines.push(`- ${family}: count=${summary.count} share=${summary.share} p50Ms=${summary.p50Ms} p95Ms=${summary.p95Ms}`);
  }

  lines.push("", "## Scenarios", "");
  for (const scenario of report.scenarios) {
    lines.push(
      `- ${scenario.sampleId} q${scenario.questionIndex} category=${scenario.category} failure=${scenario.failureClass} family=${scenario.family} latency=${scenario.latencyMs} dominantStage=${scenario.dominantStage ?? "n/a"} finalClaimSource=${scenario.finalClaimSource ?? "n/a"}`
    );
    lines.push(`  - q: ${scenario.question}`);
    lines.push(`  - answerSnippet: ${scenario.answerSnippet || "n/a"}`);
    if (scenario.reducerFamily) {
      lines.push(`  - reducerFamily: ${scenario.reducerFamily}`);
    }
    if (scenario.fallbackSuppressedReason) {
      lines.push(`  - fallbackSuppressedReason: ${scenario.fallbackSuppressedReason}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoFullResidualReview(): Promise<{
  readonly report: LoCoMoFullResidualReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const sourceArtifactPath = await resolveSourceArtifactPath();
  const artifact = JSON.parse(await readFile(sourceArtifactPath, "utf8")) as LoCoMoArtifact;
  const failing = artifact.results.filter((result) => !result.passed);
  const tokenScores = artifact.results
    .map((result) => tokenOverlapScore(result.expectedAnswer, result.answerSnippet))
    .filter((score): score is TokenOverlapScore => score !== null);
  const avgTokenMetric = (key: keyof TokenOverlapScore): number =>
    tokenScores.length > 0
      ? Number((tokenScores.reduce((sum, score) => sum + score[key], 0) / Math.max(1, tokenScores.length)).toFixed(3))
      : 0;

  const familyBuckets = new Map<string, LoCoMoArtifactResult[]>();
  for (const result of failing) {
    const family = classifyResidualFamily(result);
    const bucket = familyBuckets.get(family) ?? [];
    bucket.push(result);
    familyBuckets.set(family, bucket);
  }

  const families = Object.fromEntries(
    [...familyBuckets.entries()]
      .sort((left, right) => right[1].length - left[1].length)
      .map(([family, bucket]) => [
        family,
        {
          count: bucket.length,
          share: Number((bucket.length / Math.max(1, failing.length)).toFixed(3)),
          p50Ms: percentile(bucket.map((item) => item.latencyMs), 50),
          p95Ms: percentile(bucket.map((item) => item.latencyMs), 95)
        } satisfies ResidualFamilySummary
      ])
  );

  const scenarios: ResidualScenario[] = failing
    .sort((left, right) => right.latencyMs - left.latencyMs)
    .slice(0, 200)
    .map((result) => ({
      sampleId: result.sampleId,
      questionIndex: result.questionIndex,
      category: result.category,
      question: result.question,
      failureClass: result.failureClass,
      family: classifyResidualFamily(result),
      latencyMs: result.latencyMs,
      dominantStage: result.dominantStage ?? null,
      finalClaimSource: result.finalClaimSource ?? null,
      reducerFamily: result.reducerFamily ?? null,
      fallbackSuppressedReason: result.fallbackSuppressedReason ?? null,
      subjectMatch: result.subjectMatch ?? null,
      sufficiency: result.sufficiency ?? null,
      evidenceCount: result.evidenceCount,
      sourceCount: result.sourceCount,
      answerSnippet: result.answerSnippet
    }));

  const report: LoCoMoFullResidualReviewReport = {
    generatedAt: new Date().toISOString(),
    sourceArtifactPath,
    sourceGeneratedAt: artifact.generatedAt,
    dataset: artifact.dataset,
    benchmarkMode: artifact.runtime?.benchmarkMode ?? null,
    sampleCount: artifact.sampleCount,
    passRate: artifact.passRate,
    latency: artifact.latency,
    failingCount: failing.length,
    nonEmptyAnswerTokenPrecision: avgTokenMetric("precision"),
    nonEmptyAnswerTokenRecall: avgTokenMetric("recall"),
    nonEmptyAnswerTokenF1: avgTokenMetric("f1"),
    failureBreakdown: Object.fromEntries(
      [...new Set(failing.map((result) => result.failureClass))].sort().map((failureClass) => [
        failureClass,
        failing.filter((result) => result.failureClass === failureClass).length
      ])
    ),
    families,
    recommendedTracks: recommendedTracks(failing),
    scenarios
  };

  await mkdir(outputDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir(), `locomo-full-residual-review-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `locomo-full-residual-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}
