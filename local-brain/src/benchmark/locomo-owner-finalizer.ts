import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactPassRate,
  isUnsupportedNoEvidenceSuccess,
  observedQuestionCount,
  plannedQuestionCount,
  readLoCoMoArtifact
} from "./locomo-diagnostics-utils.js";

type ResidualOwner =
  | "pass"
  | "report_semantics"
  | "subject_binding"
  | "temporal_rendering"
  | "list_set_rendering"
  | "route_ranking"
  | "source_missing"
  | "compiler_missing"
  | "harness";

interface LoCoMoOwnerResult {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly answerSnippet: string;
  readonly passed: boolean;
  readonly normalizedPassed: boolean;
  readonly failureClass: string;
  readonly queryBehavior: string;
  readonly finalClaimSource?: string | null;
  readonly shapingDiagnosis?: string | null;
  readonly residualOwner?: ResidualOwner | string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly sufficiency?: string | null;
  readonly subjectMatch?: string | null;
  readonly dominantStage?: string | null;
  readonly sourceBoundEvidenceRequired?: boolean;
  readonly sourceBoundEvidencePresent?: boolean;
  readonly readerEvidenceDisciplineStatus?: string | null;
  readonly compiledDirectFactLookupTried?: boolean;
  readonly compiledDirectFactLookupSucceeded?: boolean;
  readonly directFactFamily?: string | null;
  readonly compiledDirectFactCoverageStatus?: string | null;
  readonly compiledProfileInferenceLookupTried?: boolean;
  readonly compiledProfileInferenceLookupSucceeded?: boolean;
  readonly profileInferenceFamily?: string | null;
  readonly premiseCoverageStatus?: string | null;
  readonly sourceBoundFallbackUsed?: boolean;
  readonly queryTimeExtractorUsed?: boolean;
  readonly queryTimeGLiNEROrLLMUsed?: boolean;
  readonly ownerEvidence?: Record<string, unknown>;
}

interface LoCoMoOwnerArtifact {
  readonly generatedAt: string;
  readonly dataset: string;
  readonly status?: string;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly latency?: {
    readonly p50Ms?: number;
    readonly p95Ms?: number;
    readonly maxMs?: number;
  };
  readonly diagnostics?: {
    readonly residualOwnerBreakdown?: Record<string, number>;
    readonly unsupportedNoEvidenceSuccessCount?: number;
  };
  readonly results: readonly LoCoMoOwnerResult[];
}

interface OwnerScenario {
  readonly sampleId: string;
  readonly questionIndex: number;
  readonly category: number;
  readonly owner: string;
  readonly queryBehavior: string;
  readonly finalClaimSource: string | null;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly subjectMatch: string | null;
  readonly sufficiency: string | null;
  readonly dominantStage: string | null;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly answerSnippet: string;
  readonly readerEvidenceDisciplineStatus: string | null;
  readonly compiledDirectFactLookupTried: boolean;
  readonly compiledDirectFactLookupSucceeded: boolean;
  readonly directFactFamily: string | null;
  readonly compiledDirectFactCoverageStatus: string | null;
  readonly compiledProfileInferenceLookupTried: boolean;
  readonly compiledProfileInferenceLookupSucceeded: boolean;
  readonly profileInferenceFamily: string | null;
  readonly premiseCoverageStatus: string | null;
  readonly sourceBoundFallbackUsed: boolean;
  readonly queryTimeExtractorUsed: boolean;
  readonly queryTimeGLiNEROrLLMUsed: boolean;
}

interface LoCoMoOwnerFinalizerReport {
  readonly generatedAt: string;
  readonly benchmark: "locomo_owner_finalizer";
  readonly sourceArtifactPath: string;
  readonly sourceGeneratedAt: string;
  readonly sourceStatus: string;
  readonly observedQuestionCount: number;
  readonly plannedQuestionCount: number;
  readonly sampleCount: number;
  readonly passRate: number;
  readonly targetPassRate: number;
  readonly passed: boolean;
  readonly unknownOwnerCount: number;
  readonly unsupportedNoEvidenceSuccessCount: number;
  readonly ownerBreakdown: Readonly<Record<string, number>>;
  readonly noEvidenceSuccesses: readonly OwnerScenario[];
  readonly scenariosByOwner: Readonly<Record<string, readonly OwnerScenario[]>>;
  readonly recommendedTracks: readonly string[];
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

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function fallbackOwner(result: LoCoMoOwnerResult): string {
  if (result.residualOwner && result.residualOwner !== "pass") {
    return result.residualOwner;
  }
  if (result.passed) {
    return "pass";
  }
  if (result.subjectMatch === "mixed" || result.subjectMatch === "mismatched" || result.subjectMatch === "unknown") {
    return "subject_binding";
  }
  if (result.failureClass === "temporal" || result.shapingDiagnosis === "temporal_rendering_wrong") {
    return "temporal_rendering";
  }
  if (result.shapingDiagnosis === "list_set_rendering_wrong") {
    return "list_set_rendering";
  }
  if (result.evidenceCount === 0 || result.sourceCount === 0) {
    return "source_missing";
  }
  if (result.finalClaimSource === "canonical_report" || result.finalClaimSource === "canonical_profile") {
    return "report_semantics";
  }
  if (result.failureClass === "retrieval" || result.failureClass === "abstention") {
    return "route_ranking";
  }
  return "compiler_missing";
}

function scenario(result: LoCoMoOwnerResult, owner: string): OwnerScenario {
  return {
    sampleId: result.sampleId,
    questionIndex: result.questionIndex,
    category: result.category,
    owner,
    queryBehavior: result.queryBehavior,
    finalClaimSource: result.finalClaimSource ?? null,
    evidenceCount: result.evidenceCount,
    sourceCount: result.sourceCount,
    subjectMatch: result.subjectMatch ?? null,
    sufficiency: result.sufficiency ?? null,
    dominantStage: result.dominantStage ?? null,
    question: result.question,
    expectedAnswer: result.expectedAnswer,
    answerSnippet: result.answerSnippet,
    readerEvidenceDisciplineStatus: result.readerEvidenceDisciplineStatus ?? null,
    compiledDirectFactLookupTried: result.compiledDirectFactLookupTried === true,
    compiledDirectFactLookupSucceeded: result.compiledDirectFactLookupSucceeded === true,
    directFactFamily: result.directFactFamily ?? null,
    compiledDirectFactCoverageStatus: result.compiledDirectFactCoverageStatus ?? null,
    compiledProfileInferenceLookupTried: result.compiledProfileInferenceLookupTried === true,
    compiledProfileInferenceLookupSucceeded: result.compiledProfileInferenceLookupSucceeded === true,
    profileInferenceFamily: result.profileInferenceFamily ?? null,
    premiseCoverageStatus: result.premiseCoverageStatus ?? null,
    sourceBoundFallbackUsed: result.sourceBoundFallbackUsed === true,
    queryTimeExtractorUsed: result.queryTimeExtractorUsed === true,
    queryTimeGLiNEROrLLMUsed: result.queryTimeGLiNEROrLLMUsed === true
  };
}

function recommendedTracks(ownerBreakdown: Readonly<Record<string, number>>): readonly string[] {
  const tracks: string[] = [];
  if ((ownerBreakdown.report_semantics ?? 0) > 0) tracks.push("tighten canonical/profile reader evidence discipline");
  if ((ownerBreakdown.subject_binding ?? 0) > 0) tracks.push("strengthen subject-scoped recall and mixed-owner rejection");
  if ((ownerBreakdown.temporal_rendering ?? 0) > 0) tracks.push("finish temporal semantic reader granularity contracts");
  if ((ownerBreakdown.list_set_rendering ?? 0) > 0) tracks.push("require explicit set/list support before list answers");
  if ((ownerBreakdown.route_ranking ?? 0) > 0) tracks.push("promote source-bound direct routes before broad fallback");
  if ((ownerBreakdown.source_missing ?? 0) > 0) tracks.push("verify source coverage before compiler/retrieval work");
  return tracks;
}

function toMarkdown(report: LoCoMoOwnerFinalizerReport): string {
  const lines = [
    "# LoCoMo Owner Finalizer",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifactPath: ${report.sourceArtifactPath}`,
    `- sourceGeneratedAt: ${report.sourceGeneratedAt}`,
    `- sourceStatus: ${report.sourceStatus}`,
    `- observedQuestionCount: ${report.observedQuestionCount}`,
    `- plannedQuestionCount: ${report.plannedQuestionCount}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passRate: ${report.passRate}`,
    `- targetPassRate: ${report.targetPassRate}`,
    `- passed: ${report.passed}`,
    `- unknownOwnerCount: ${report.unknownOwnerCount}`,
    `- unsupportedNoEvidenceSuccessCount: ${report.unsupportedNoEvidenceSuccessCount}`,
    `- ownerBreakdown: ${JSON.stringify(report.ownerBreakdown)}`,
    "",
    "## Recommended Tracks",
    "",
    ...report.recommendedTracks.map((track) => `- ${track}`),
    "",
    "## Scenarios By Owner",
    ""
  ];
  for (const [owner, scenarios] of Object.entries(report.scenariosByOwner)) {
    lines.push(`### ${owner}`, "");
    for (const item of scenarios.slice(0, 12)) {
      lines.push(`- ${item.sampleId}#${item.questionIndex} category=${item.category} behavior=${item.queryBehavior} final=${item.finalClaimSource ?? "n/a"} evidence=${item.evidenceCount}/${item.sourceCount}`);
      if (item.compiledProfileInferenceLookupTried) {
        lines.push(`  - profile_inference: family=${item.profileInferenceFamily ?? "n/a"} compiled=${item.compiledProfileInferenceLookupSucceeded ? "selected" : item.premiseCoverageStatus ?? "missed"}`);
      }
      lines.push(`  - direct_fact: family=${item.directFactFamily ?? "n/a"} compiled=${item.compiledDirectFactLookupTried ? item.compiledDirectFactCoverageStatus ?? "tried" : "not_tried"} fallback=${item.sourceBoundFallbackUsed} extractor=${item.queryTimeExtractorUsed}`);
      lines.push(`  - q: ${item.question}`);
      lines.push(`  - expected: ${item.expectedAnswer}`);
      lines.push(`  - answer: ${item.answerSnippet}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLoCoMoOwnerFinalizer(): Promise<{
  readonly report: LoCoMoOwnerFinalizerReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}>;
export async function runAndWriteLoCoMoOwnerFinalizer(options: {
  readonly artifactPath?: string;
}): Promise<{
  readonly report: LoCoMoOwnerFinalizerReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}>;
export async function runAndWriteLoCoMoOwnerFinalizer(options?: {
  readonly artifactPath?: string;
}): Promise<{
  readonly report: LoCoMoOwnerFinalizerReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const source = (await readLoCoMoArtifact(import.meta.url, options?.artifactPath)) as {
    readonly path: string;
    readonly report: LoCoMoOwnerArtifact;
  };
  const failures = source.report.results.filter((result) => !result.passed);
  const noEvidenceSuccesses = source.report.results.filter(isUnsupportedNoEvidenceSuccess);
  const ownerScenarios = [
    ...failures.map((result) => scenario(result, fallbackOwner(result))),
    ...noEvidenceSuccesses.map((result) => scenario(result, "unsupported_no_evidence_success"))
  ];
  const ownerBreakdown: Record<string, number> = {};
  for (const item of ownerScenarios) {
    ownerBreakdown[item.owner] = (ownerBreakdown[item.owner] ?? 0) + 1;
  }
  const scenariosByOwner: Record<string, OwnerScenario[]> = {};
  for (const item of ownerScenarios) {
    scenariosByOwner[item.owner] ??= [];
    scenariosByOwner[item.owner]!.push(item);
  }
  const unknownOwnerCount = ownerScenarios.filter((item) => item.owner === "unknown" || !item.owner).length;
  const targetPassRate = 0.92;
  const passRate = artifactPassRate(source.report);
  const report: LoCoMoOwnerFinalizerReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "locomo_owner_finalizer",
    sourceArtifactPath: source.path,
    sourceGeneratedAt: source.report.generatedAt ?? "unknown",
    sourceStatus: source.report.status ?? "complete",
    observedQuestionCount: observedQuestionCount(source.report),
    plannedQuestionCount: plannedQuestionCount(source.report),
    sampleCount: source.report.sampleCount ?? observedQuestionCount(source.report),
    passRate,
    targetPassRate,
    passed: passRate >= targetPassRate && unknownOwnerCount === 0 && noEvidenceSuccesses.length === 0,
    unknownOwnerCount,
    unsupportedNoEvidenceSuccessCount: noEvidenceSuccesses.length,
    ownerBreakdown,
    noEvidenceSuccesses: noEvidenceSuccesses.map((result) => scenario(result, "unsupported_no_evidence_success")),
    scenariosByOwner,
    recommendedTracks: recommendedTracks(ownerBreakdown)
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `locomo-owner-finalizer-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `locomo-owner-finalizer-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}
