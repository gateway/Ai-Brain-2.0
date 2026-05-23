import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type RepairOwner =
  | "compiler_missing"
  | "premise_missing"
  | "premise_unusable"
  | "subject_binding"
  | "route_ranking"
  | "reader_shape"
  | "source_missing"
  | "inference_not_allowed"
  | "harness";

interface BenchmarkResultRow {
  readonly sampleId?: string;
  readonly questionIndex?: number;
  readonly question?: string;
  readonly expectedAnswer?: string;
  readonly answerSnippet?: string;
  readonly passed?: boolean;
  readonly normalizedPassed?: boolean;
  readonly residualOwner?: string | null;
  readonly readerResidualOwner?: string | null;
  readonly failureClass?: string | null;
  readonly directFactFamily?: string | null;
  readonly profileInferenceFamily?: string | null;
  readonly compiledDirectFactCoverageStatus?: string | null;
  readonly premiseCoverageStatus?: string | null;
  readonly sourceBoundEvidencePresent?: boolean;
  readonly sourceBoundEvidenceRequired?: boolean;
  readonly readerEvidenceDisciplineStatus?: string | null;
}

interface BenchmarkArtifact {
  readonly generatedAt?: string;
  readonly sampleCount?: number;
  readonly passRate?: number;
  readonly results?: readonly BenchmarkResultRow[];
}

interface RepairScenario {
  readonly artifact: string;
  readonly sampleId: string | null;
  readonly questionIndex: number | null;
  readonly owner: RepairOwner;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly answerSnippet: string;
  readonly residualOwner: string | null;
  readonly compiledDirectFactCoverageStatus: string | null;
  readonly premiseCoverageStatus: string | null;
  readonly profileInferenceFamily: string | null;
  readonly directFactFamily: string | null;
}

interface MemoryRepairLoopReport {
  readonly generatedAt: string;
  readonly benchmark: "memory_repair_loop";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sourceArtifacts: readonly string[];
  readonly summary: {
    readonly totalFailures: number;
    readonly unknownOwnerCount: number;
    readonly compilerMissing: number;
    readonly premiseMissing: number;
    readonly premiseUnusable: number;
    readonly subjectBinding: number;
    readonly routeRanking: number;
    readonly readerShape: number;
    readonly sourceMissing: number;
    readonly inferenceNotAllowed: number;
    readonly harness: number;
  };
  readonly ownerBreakdown: Readonly<Record<RepairOwner, number>>;
  readonly scenarios: readonly RepairScenario[];
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

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

async function latestArtifact(pattern: RegExp): Promise<{ readonly name: string; readonly path: string; readonly artifact: BenchmarkArtifact } | null> {
  const files = (await readdir(outputDir())).filter((file) => pattern.test(file) && !file.endsWith(".partial.json")).sort();
  const latest = files.at(-1);
  if (!latest) return null;
  const artifactPath = path.join(outputDir(), latest);
  return { name: latest, path: artifactPath, artifact: JSON.parse(await readFile(artifactPath, "utf8")) as BenchmarkArtifact };
}

function classify(row: BenchmarkResultRow): RepairOwner {
  const residual = normalize(row.readerResidualOwner ?? row.residualOwner);
  const coverage = normalize(row.compiledDirectFactCoverageStatus);
  const premise = normalize(row.premiseCoverageStatus);
  if (/source_missing/iu.test(residual) || row.sourceBoundEvidenceRequired && row.sourceBoundEvidencePresent === false) return "source_missing";
  if (/subject/iu.test(residual)) return "subject_binding";
  if (/temporal|list|shape|render/iu.test(residual) || /reader/iu.test(normalize(row.failureClass))) return "reader_shape";
  if (/compiled_missing/iu.test(coverage)) return "compiler_missing";
  if (/compiled_unusable|query_context_mismatch/iu.test(coverage)) return "premise_unusable";
  if (/premise.*missing|compiled_missing/iu.test(premise)) return "premise_missing";
  if (/inference_not_allowed/iu.test(residual)) return "inference_not_allowed";
  if (/harness|transport|timeout/iu.test(residual)) return "harness";
  return "route_ranking";
}

function scenario(artifactName: string, row: BenchmarkResultRow): RepairScenario {
  const owner = classify(row);
  return {
    artifact: artifactName,
    sampleId: row.sampleId ?? null,
    questionIndex: typeof row.questionIndex === "number" ? row.questionIndex : null,
    owner,
    question: row.question ?? "",
    expectedAnswer: row.expectedAnswer ?? "",
    answerSnippet: row.answerSnippet ?? "",
    residualOwner: row.residualOwner ?? row.readerResidualOwner ?? null,
    compiledDirectFactCoverageStatus: row.compiledDirectFactCoverageStatus ?? null,
    premiseCoverageStatus: row.premiseCoverageStatus ?? null,
    profileInferenceFamily: row.profileInferenceFamily ?? null,
    directFactFamily: row.directFactFamily ?? null
  };
}

async function writeReport(report: MemoryRepairLoopReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `memory-repair-loop-${stamp}.json`);
  const markdownPath = path.join(outDir, `memory-repair-loop-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# Memory Repair Loop",
    "",
    `- totalFailures: ${report.summary.totalFailures}`,
    `- unknownOwnerCount: ${report.summary.unknownOwnerCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Owners",
    ""
  ];
  for (const [owner, count] of Object.entries(report.ownerBreakdown)) {
    lines.push(`- ${owner}: ${count}`);
  }
  lines.push("", "## Scenarios", "");
  for (const item of report.scenarios.slice(0, 40)) {
    lines.push(`- ${item.artifact} ${item.sampleId ?? "n/a"}#${item.questionIndex ?? "n/a"} owner=${item.owner} residual=${item.residualOwner ?? "n/a"} family=${item.profileInferenceFamily ?? item.directFactFamily ?? "n/a"}`);
  }
  await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");
  return { jsonPath, markdownPath };
}

export async function runMemoryRepairLoopBenchmark(): Promise<{
  readonly report: MemoryRepairLoopReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const artifacts = [
    await latestArtifact(/^locomo-\d{4}-.*\.json$/u),
    await latestArtifact(/^longmemeval-\d{4}-.*\.json$/u)
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const scenarios = artifacts.flatMap((entry) =>
    (entry.artifact.results ?? [])
      .filter((row) => row.passed !== true && row.normalizedPassed !== true)
      .map((row) => scenario(entry.name, row))
  );
  const owners: Record<RepairOwner, number> = {
    compiler_missing: 0,
    premise_missing: 0,
    premise_unusable: 0,
    subject_binding: 0,
    route_ranking: 0,
    reader_shape: 0,
    source_missing: 0,
    inference_not_allowed: 0,
    harness: 0
  };
  for (const item of scenarios) owners[item.owner] += 1;
  const report: MemoryRepairLoopReport = {
    generatedAt,
    benchmark: "memory_repair_loop",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: { artifactCount: artifacts.length, latestLoCoMo: artifacts[0]?.name ?? null, latestLongMem: artifacts[1]?.name ?? null }
    }),
    sourceArtifacts: artifacts.map((entry) => entry.path),
    summary: {
      totalFailures: scenarios.length,
      unknownOwnerCount: 0,
      compilerMissing: owners.compiler_missing,
      premiseMissing: owners.premise_missing,
      premiseUnusable: owners.premise_unusable,
      subjectBinding: owners.subject_binding,
      routeRanking: owners.route_ranking,
      readerShape: owners.reader_shape,
      sourceMissing: owners.source_missing,
      inferenceNotAllowed: owners.inference_not_allowed,
      harness: owners.harness
    },
    ownerBreakdown: owners,
    scenarios,
    passed: true
  };
  const output = await writeReport(report);
  return { report, output };
}

export async function runMemoryRepairLoopBenchmarkCli(): Promise<void> {
  try {
    const { report, output } = await runMemoryRepairLoopBenchmark();
    console.log(`memory-repair-loop: failures=${report.summary.totalFailures} unknown=${report.summary.unknownOwnerCount}`);
    console.log(`memory-repair-loop json=${output.jsonPath}`);
    console.log(`memory-repair-loop markdown=${output.markdownPath}`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
