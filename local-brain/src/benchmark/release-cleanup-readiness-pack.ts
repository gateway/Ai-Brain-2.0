import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { benchmarkOutputDir } from "./query-benchmark-utils.js";

const execFileAsync = promisify(execFile);

type PathCategory =
  | "current_slice"
  | "phase_documentation"
  | "benchmark_source"
  | "core_source"
  | "migration"
  | "docs"
  | "generated_or_local_state"
  | "potential_private"
  | "misc";

interface DirtyPath {
  readonly status: string;
  readonly path: string;
  readonly category: PathCategory;
  readonly currentSliceOwned: boolean;
  readonly pushRisk: "low" | "medium" | "high";
}

const CURRENT_SLICE_PATHS = new Set([
  ".gitignore",
  "brain-spec/local/2026-05-21-ai-brain-master-phase-task-list.md",
  "brain-spec/local/2026-05-23-phase-15-ceo-demo-product-readiness-checkpoint.md",
  "brain-spec/local/2026-05-23-phase-16-provider-pdf-and-release-cleanup-checkpoint.md",
  "local-brain/CHANGELOG.md",
  "local-brain/package.json",
  "local-brain/src/benchmark/ceo-demo-readiness-pack.ts",
  "local-brain/src/benchmark/multimodal-worker-smoke.ts",
  "local-brain/src/benchmark/operator-dashboard.ts",
  "local-brain/src/benchmark/release-cleanup-readiness-pack.ts",
  "local-brain/src/cli/benchmark-ceo-demo-readiness-pack.ts",
  "local-brain/src/cli/benchmark-release-cleanup-readiness-pack.ts"
]);

function categorize(filePath: string, currentSliceOwned: boolean): PathCategory {
  if (currentSliceOwned) return "current_slice";
  if (/^(?:local-brain\/)?(?:cache|logs|config)\//u.test(filePath) || filePath.includes(".env")) return "potential_private";
  if (filePath.includes("benchmark-results/") || filePath.includes("benchmark-generated/") || filePath.includes(".DS_Store")) return "generated_or_local_state";
  if (filePath.startsWith("brain-spec/local/")) return "phase_documentation";
  if (/^local-brain\/src\/(?:benchmark|cli\/benchmark-)/u.test(filePath)) return "benchmark_source";
  if (filePath.startsWith("local-brain/migrations/")) return "migration";
  if (filePath.startsWith("local-brain/src/")) return "core_source";
  if (filePath.startsWith("docs/") || filePath.startsWith("local-brain/docs/") || filePath.startsWith("notes/")) return "docs";
  return "misc";
}

function pushRisk(category: PathCategory, status: string): DirtyPath["pushRisk"] {
  if (category === "potential_private" || category === "generated_or_local_state") return "high";
  if (category === "core_source" || category === "migration" || status.includes("D")) return "medium";
  return "low";
}

function parsePorcelain(output: string): readonly DirtyPath[] {
  if (!output.trim()) return [];
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      const currentSliceOwned = CURRENT_SLICE_PATHS.has(filePath);
      const category = categorize(filePath, currentSliceOwned);
      return {
        status,
        path: filePath,
        category,
        currentSliceOwned,
        pushRisk: pushRisk(category, status)
      };
    });
}

function markdownFor(report: any): string {
  const lines = [
    "# Release Cleanup Readiness Pack",
    "",
    `- passed: ${report.passed}`,
    `- readyToPush: ${report.metrics.readyToPush}`,
    `- totalDirtyPaths: ${report.metrics.totalDirtyPaths}`,
    `- currentSlicePathCount: ${report.metrics.currentSlicePathCount}`,
    `- unrelatedDirtyPathCount: ${report.metrics.unrelatedDirtyPathCount}`,
    `- highRiskPathCount: ${report.metrics.highRiskPathCount}`,
    "",
    "## Category Counts",
    "",
    ...Object.entries(report.metrics.categoryCounts).map(([category, count]) => `- ${category}: ${count}`),
    "",
    "## Current Slice Paths",
    "",
    ...report.paths.filter((item: DirtyPath) => item.currentSliceOwned).map((item: DirtyPath) => `- ${item.status} ${item.path}`),
    "",
    "## High-Risk Or Local-State Paths",
    "",
    ...report.paths.filter((item: DirtyPath) => item.pushRisk === "high").slice(0, 80).map((item: DirtyPath) => `- ${item.status} ${item.path} (${item.category})`),
    "",
    "## Recommendation",
    "",
    report.metrics.readyToPush
      ? "The current slice can be staged and pushed directly."
      : "Do not push the whole worktree. Stage only reviewed slice files or split the historical dirty worktree into smaller commits after owner review."
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteReleaseCleanupReadinessPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
    maxBuffer: 20 * 1024 * 1024
  });
  const paths = parsePorcelain(stdout);
  const categoryCounts = paths.reduce<Record<string, number>>((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
  const highRiskPathCount = paths.filter((item) => item.pushRisk === "high").length;
  const currentSlicePathCount = paths.filter((item) => item.currentSliceOwned).length;
  const unrelatedDirtyPathCount = paths.filter((item) => !item.currentSliceOwned).length;
  const readyToPush = unrelatedDirtyPathCount === 0 && highRiskPathCount === 0;
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "release_cleanup_readiness_pack",
    passed: readyToPush,
    metrics: {
      totalDirtyPaths: paths.length,
      trackedModifiedCount: paths.filter((item) => !item.status.startsWith("??")).length,
      untrackedCount: paths.filter((item) => item.status.startsWith("??")).length,
      currentSlicePathCount,
      unrelatedDirtyPathCount,
      highRiskPathCount,
      readyToPush,
      categoryCounts
    },
    currentSliceAllowlist: [...CURRENT_SLICE_PATHS],
    paths
  };
  await mkdir(benchmarkOutputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(benchmarkOutputDir(), `release-cleanup-readiness-pack-${stamp}.json`);
  const markdownPath = path.join(benchmarkOutputDir(), `release-cleanup-readiness-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runReleaseCleanupReadinessPackCli(): Promise<void> {
  const { report, output } = await runAndWriteReleaseCleanupReadinessPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
