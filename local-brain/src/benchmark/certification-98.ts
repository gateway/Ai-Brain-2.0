import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { closePool } from "../db/client.js";
import { resetNamespaceData } from "../cli/reset-namespace.js";
import { replayNamespaceSources } from "../cli/replay-namespace-sources.js";
import { runAndWriteAbstentionReviewBenchmark } from "./abstention-review.js";
import { runAndWriteCanonicalIdentityReview } from "./canonical-identity-review.js";
import { runAndWriteClarificationTruthReviewBenchmark } from "./clarification-truth-review.js";
import { runAndWriteGraphRetrievalReviewBenchmark } from "./graph-retrieval-review.js";
import { runAndWriteLifeReplayBenchmark } from "./life-replay.js";
import { runAndWriteLifeScaleBenchmark } from "./life-scale.js";
import { runAndWriteLoCoMoBenchmark } from "./locomo.js";
import { runAndWriteMcpProductionSmokeBenchmark } from "./mcp-production-smoke.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";
import { runAndWritePersonalOmiReview } from "./personal-omi-review.js";
import { runAndWritePersonalOpenClawReviewBenchmark } from "./personal-openclaw-review.js";
import { runAndWriteProfileRoutingReviewBenchmark } from "./profile-routing-review.js";
import { runAndWritePublicMemoryMissRegressionsBenchmark } from "./public-memory-miss-regressions.js";
import { runAndWriteRecursiveReflectReviewBenchmark } from "./recursive-reflect-review.js";
import { runAndWriteSessionStartMemoryBenchmark } from "./session-start-memory.js";
import { runAndWriteTemporalDifferentialBenchmark } from "./temporal-differential.js";

interface CertificationArtifact {
  readonly name: string;
  readonly passed: boolean;
  readonly artifactPath: string;
  readonly note?: string;
}

interface CertificationRepeat {
  readonly repeatIndex: number;
  readonly passed: boolean;
  readonly artifacts: readonly CertificationArtifact[];
}

export interface Certification98Report {
  readonly generatedAt: string;
  readonly repeatsRequested: number;
  readonly repeatsPassed: number;
  readonly componentCertificationPassed: boolean;
  readonly largerValidationPassed: boolean;
  readonly dashboardValidationPassed: boolean;
  readonly release98Passed: boolean;
  readonly repeats: readonly CertificationRepeat[];
  readonly largerValidation: readonly CertificationArtifact[];
  readonly dashboardValidation: readonly CertificationArtifact[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function repoRoot(): string {
  return path.resolve(localBrainRoot(), "..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function cleanReplayNamespace(namespaceId: string): Promise<void> {
  await resetNamespaceData(namespaceId);
  await replayNamespaceSources(namespaceId, {
    forceImport: true
  });
  await closePool();
  await import("../typed-memory/service.js").then(({ rebuildTypedMemoryNamespace }) => rebuildTypedMemoryNamespace(namespaceId));
}

async function cleanReplayPersonalNamespaces(): Promise<void> {
  await cleanReplayNamespace("personal");
  await closePool();
  await cleanReplayNamespace("personal_continuity_shadow");
  await closePool();
}

async function runComponentRepeat(repeatIndex: number): Promise<CertificationRepeat> {
  await cleanReplayPersonalNamespaces();

  const sessionStart = await runAndWriteSessionStartMemoryBenchmark();
  const personalOpenclaw = await runAndWritePersonalOpenClawReviewBenchmark();
  const canonicalIdentity = await runAndWriteCanonicalIdentityReview();
  const clarificationTruth = await runAndWriteClarificationTruthReviewBenchmark();
  const personalOmi = await runAndWritePersonalOmiReview();
  const mcpProduction = await runAndWriteMcpProductionSmokeBenchmark();
  const omiWatch = await runAndWriteOmiWatchSmokeBenchmark();
  const profileRouting = await runAndWriteProfileRoutingReviewBenchmark();
  const recursiveReflect = await runAndWriteRecursiveReflectReviewBenchmark();
  const publicMisses = await runAndWritePublicMemoryMissRegressionsBenchmark();

  const artifacts: CertificationArtifact[] = [
    {
      name: "canonical_identity_review",
      passed: canonicalIdentity.report.summary.fail === 0,
      artifactPath: canonicalIdentity.output.jsonPath
    },
    {
      name: "clarification_truth_review",
      passed: clarificationTruth.report.summary.fail === 0,
      artifactPath: clarificationTruth.output.jsonPath
    },
    {
      name: "personal_openclaw_review",
      passed: personalOpenclaw.report.summary.fail === 0 && personalOpenclaw.report.sourceShape.passed,
      artifactPath: personalOpenclaw.output.jsonPath
    },
    {
      name: "session_start_memory",
      passed: sessionStart.report.passed,
      artifactPath: sessionStart.output.jsonPath
    },
    {
      name: "personal_omi_review",
      passed: personalOmi.report.summary.fail === 0 && personalOmi.report.summary.warning === 0,
      artifactPath: personalOmi.jsonPath
    },
    {
      name: "mcp_production_smoke",
      passed: mcpProduction.report.passed,
      artifactPath: mcpProduction.output.jsonPath
    },
    {
      name: "omi_watch",
      passed: omiWatch.report.passed,
      artifactPath: omiWatch.output.jsonPath
    },
    {
      name: "profile_routing_review",
      passed: profileRouting.report.summary.fail === 0,
      artifactPath: profileRouting.output.jsonPath
    },
    {
      name: "recursive_reflect_review",
      passed: recursiveReflect.report.summary.fail === 0,
      artifactPath: recursiveReflect.output.jsonPath
    },
    {
      name: "public_memory_miss_regressions",
      passed: publicMisses.report.passed,
      artifactPath: publicMisses.output.jsonPath
    }
  ];

  return {
    repeatIndex,
    passed: artifacts.every((artifact) => artifact.passed),
    artifacts
  };
}

async function runLargerValidation(): Promise<readonly CertificationArtifact[]> {
  const abstention = await runAndWriteAbstentionReviewBenchmark();
  const graphRetrieval = await runAndWriteGraphRetrievalReviewBenchmark();
  const temporalDifferential = await runAndWriteTemporalDifferentialBenchmark();
  const lifeReplay = await runAndWriteLifeReplayBenchmark();
  const lifeScale = await runAndWriteLifeScaleBenchmark();

  process.env.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS = "10";
  process.env.BRAIN_LOCOMO_SAMPLE_QUESTIONS = "10";
  process.env.BRAIN_LOCOMO_STRATIFIED = "1";
  process.env.BRAIN_LOCOMO_CATEGORY_LIMIT = "2";
  const locomo = await runAndWriteLoCoMoBenchmark();

  return [
    {
      name: "abstention_review",
      passed: abstention.report.summary.fail === 0,
      artifactPath: abstention.output.jsonPath
    },
    {
      name: "graph_retrieval_review",
      passed: graphRetrieval.report.summary.fail === 0,
      artifactPath: graphRetrieval.output.jsonPath
    },
    {
      name: "temporal_differential",
      passed: temporalDifferential.report.passed,
      artifactPath: temporalDifferential.output.jsonPath
    },
    {
      name: "life_replay",
      passed: lifeReplay.report.passed,
      artifactPath: lifeReplay.output.jsonPath
    },
    {
      name: "life_scale",
      passed: lifeScale.report.passed,
      artifactPath: lifeScale.output.jsonPath
    },
    {
      name: "locomo_standard",
      passed: locomo.report.passRate >= 0.45,
      artifactPath: locomo.output.jsonPath,
      note: `passRate=${locomo.report.passRate}`
    }
  ];
}

async function runDashboardValidation(): Promise<readonly CertificationArtifact[]> {
  const root = repoRoot();
  await runCommand("npm", ["run", "lint", "--workspace", "brain-console"], root);
  await runCommand("npm", ["run", "build", "--workspace", "brain-console"], root);
  return [
    {
      name: "brain_console_lint",
      passed: true,
      artifactPath: path.join(root, "brain-console")
    },
    {
      name: "brain_console_build",
      passed: true,
      artifactPath: path.join(root, "brain-console")
    }
  ];
}

function toMarkdown(report: Certification98Report): string {
  const lines: string[] = [
    "# Certification 98",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- repeatsRequested: ${report.repeatsRequested}`,
    `- repeatsPassed: ${report.repeatsPassed}`,
    `- componentCertificationPassed: ${report.componentCertificationPassed}`,
    `- largerValidationPassed: ${report.largerValidationPassed}`,
    `- dashboardValidationPassed: ${report.dashboardValidationPassed}`,
    `- release98Passed: ${report.release98Passed}`,
    "",
    "## Repeats",
    ""
  ];

  for (const repeat of report.repeats) {
    lines.push(`### Repeat ${repeat.repeatIndex}`);
    lines.push(`- passed: ${repeat.passed}`);
    for (const artifact of repeat.artifacts) {
      lines.push(`- ${artifact.name}: ${artifact.passed ? "pass" : "fail"} | ${artifact.artifactPath}`);
    }
    lines.push("");
  }

  lines.push("## Larger Validation", "");
  for (const artifact of report.largerValidation) {
    lines.push(`- ${artifact.name}: ${artifact.passed ? "pass" : "fail"} | ${artifact.artifactPath}${artifact.note ? ` | ${artifact.note}` : ""}`);
  }

  lines.push("", "## Dashboard Validation", "");
  for (const artifact of report.dashboardValidation) {
    lines.push(`- ${artifact.name}: ${artifact.passed ? "pass" : "fail"} | ${artifact.artifactPath}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteCertification98(repeats = 3): Promise<{
  readonly report: Certification98Report;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const repeatResults: CertificationRepeat[] = [];
  for (let index = 1; index <= repeats; index += 1) {
    repeatResults.push(await runComponentRepeat(index));
    await closePool();
  }

  const largerValidation = await runLargerValidation();
  await closePool();
  const dashboardValidation = await runDashboardValidation();

  const report: Certification98Report = {
    generatedAt: new Date().toISOString(),
    repeatsRequested: repeats,
    repeatsPassed: repeatResults.filter((item) => item.passed).length,
    componentCertificationPassed: repeatResults.every((item) => item.passed),
    largerValidationPassed: largerValidation.every((item) => item.passed),
    dashboardValidationPassed: dashboardValidation.every((item) => item.passed),
    release98Passed:
      repeatResults.every((item) => item.passed) &&
      largerValidation.every((item) => item.passed) &&
      dashboardValidation.every((item) => item.passed),
    repeats: repeatResults,
    largerValidation,
    dashboardValidation
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `certification-98-${stamp}.json`);
  const markdownPath = path.join(dir, `certification-98-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runCertification98Cli(): Promise<void> {
  const repeatArg = process.argv.indexOf("--repeats");
  const repeats =
    repeatArg >= 0 && process.argv[repeatArg + 1]
      ? Math.max(1, Number.parseInt(process.argv[repeatArg + 1] ?? "3", 10) || 3)
      : 3;

  try {
    const { output, report } = await runAndWriteCertification98(repeats);
    process.stdout.write(
      `${JSON.stringify(
        {
          repeats,
          release98Passed: report.release98Passed,
          output
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closePool();
  }
}
