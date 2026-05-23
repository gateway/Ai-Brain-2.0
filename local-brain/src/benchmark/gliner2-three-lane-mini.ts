import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ThreeLaneGate {
  readonly name: string;
  readonly passed: boolean;
  readonly artifactPath: string | null;
  readonly artifactDetected: boolean;
  readonly detail: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly laneStatus: "passed" | "failed" | "timed_out" | "process_failed" | "artifact_missing";
}

export interface Gliner2ThreeLaneMiniReport {
  readonly generatedAt: string;
  readonly releaseInterpretation: {
    readonly omi: string;
    readonly longMemEval: string;
    readonly locomo: string;
  };
  readonly laneGroups: {
    readonly extractor_gate: {
      readonly passed: boolean;
      readonly gates: readonly string[];
    };
    readonly product_gate: {
      readonly passed: boolean;
      readonly gates: readonly string[];
    };
    readonly stress_gate: {
      readonly passed: boolean;
      readonly gates: readonly string[];
    };
  };
  readonly gates: readonly ThreeLaneGate[];
  readonly passed: boolean;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

async function listArtifactPaths(prefix: string): Promise<Set<string>> {
  const directory = await readdir(outputDir());
  return new Set(
    directory
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json") && !entry.endsWith(".partial.json"))
      .map((entry) => path.join(outputDir(), entry))
  );
}

async function readNewArtifactJson<T>(prefix: string, before: Set<string>): Promise<{
  readonly jsonPath: string;
  readonly report: T;
}> {
  const after = await listArtifactPaths(prefix);
  const fresh = [...after].filter((entry) => !before.has(entry)).sort();
  const jsonPath = fresh.at(-1);
  if (!jsonPath) {
    throw new Error(`No new artifact found for prefix ${prefix}`);
  }
  const payload = await readFile(jsonPath, "utf8");
  return {
    jsonPath,
    report: JSON.parse(payload) as T
  };
}

interface BenchmarkLaneExecution<T> {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly artifactDetected: boolean;
  readonly jsonPath: string | null;
  readonly report: T | null;
  readonly stdout: string;
  readonly stderr: string;
}

function trimProcessOutput(value: string, maxChars = 16000): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function killChildProcessTree(childPid: number | undefined): void {
  if (!childPid) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-childPid, "SIGKILL");
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }
  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // Child already exited.
  }
}

async function runBenchmarkCli<T>(
  scriptName: string,
  prefix: string,
  timeoutMs: number,
  env: Record<string, string> = {}
): Promise<BenchmarkLaneExecution<T>> {
  const before = await listArtifactPaths(prefix);
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const child = spawn(process.execPath, [path.join(rootDir(), "dist/cli", scriptName)], {
    cwd: rootDir(),
    env: {
      ...process.env,
      ...env
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = trimProcessOutput(stdout + chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = trimProcessOutput(stderr + chunk);
  });

  const waitForExit = new Promise<{ readonly exitCode: number | null; readonly timedOut: boolean }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ exitCode, timedOut });
    };
    const timeoutHandle = setTimeout(() => {
      killChildProcessTree(child.pid);
      finish(null, true);
    }, timeoutMs);
    child.once("error", () => {
      finish(null, false);
    });
    child.once("close", (code) => {
      finish(code, false);
    });
  });

  const exit = await waitForExit;
  let artifact: { readonly jsonPath: string; readonly report: T } | null = null;
  try {
    artifact = await readNewArtifactJson<T>(prefix, before);
  } catch {
    artifact = null;
  }

  const finishedAtIso = new Date().toISOString();
  return {
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    durationMs: Date.now() - startedAtMs,
    exitCode: exit.exitCode,
    timedOut: exit.timedOut,
    artifactDetected: Boolean(artifact),
    jsonPath: artifact?.jsonPath ?? null,
    report: artifact?.report ?? null,
    stdout,
    stderr
  };
}

function summarizeFailureOutput(stdout: string, stderr: string): string {
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  if (!detail) {
    return "no output captured";
  }
  return detail.replace(/\s+/g, " ").slice(0, 600);
}

function toMarkdown(report: Gliner2ThreeLaneMiniReport): string {
  const lines = [
    "# GLiNER2 Three-Lane Mini Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    "",
    "## Release Interpretation",
    "",
    `- OMI: ${report.releaseInterpretation.omi}`,
    `- LongMemEval: ${report.releaseInterpretation.longMemEval}`,
    `- LoCoMo: ${report.releaseInterpretation.locomo}`,
    "",
    "## Lane Groups",
    "",
    `- extractor_gate: ${report.laneGroups.extractor_gate.passed ? "pass" : "fail"} | gates=${report.laneGroups.extractor_gate.gates.join(",")}`,
    `- product_gate: ${report.laneGroups.product_gate.passed ? "pass" : "fail"} | gates=${report.laneGroups.product_gate.gates.join(",")}`,
    `- stress_gate: ${report.laneGroups.stress_gate.passed ? "pass" : "fail"} | gates=${report.laneGroups.stress_gate.gates.join(",")}`,
    "",
    "## Gates",
    ""
  ];

  for (const gate of report.gates) {
    lines.push(
      `- ${gate.name}: ${gate.passed ? "pass" : "fail"} | status=${gate.laneStatus} exit=${gate.exitCode ?? "null"} timedOut=${gate.timedOut} artifactDetected=${gate.artifactDetected} durationMs=${gate.durationMs} | ${gate.detail} | ${gate.artifactPath ?? "no-artifact"}`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteGliner2ThreeLaneMiniBenchmark(): Promise<{
  readonly report: Gliner2ThreeLaneMiniReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const omiExtraction = await runBenchmarkCli<{
    readonly passed: boolean;
    readonly extractorSummaries: readonly { readonly extractor: string; readonly utilityScore: number }[];
  }>("benchmark-omi-extraction-shadow.js", "omi-extraction-shadow-", 5 * 60 * 1000);
  const personalOmi = await runBenchmarkCli<{
    readonly summary: {
      readonly pass: number;
      readonly warning: number;
      readonly fail: number;
      readonly wrongClaimWithGoodEvidence: number;
    };
  }>("benchmark-personal-omi-review.js", "personal-omi-review-", 10 * 60 * 1000);
  const omiWatch = await runBenchmarkCli<{
    readonly passed: boolean;
    readonly queries: readonly unknown[];
    readonly blockedStage: string | null;
    readonly graph: { readonly passed: boolean };
  }>("benchmark-omi-watch-smoke.js", "omi-watch-smoke-", 10 * 60 * 1000);
  const longMemEval = await runBenchmarkCli<{
    readonly passRate: number;
    readonly sampleCount: number;
  }>("benchmark-longmemeval.js", "longmemeval-", 10 * 60 * 1000);
  const loCoMo = await runBenchmarkCli<{
    readonly passRate: number;
    readonly sampleCount: number;
    readonly results: readonly { readonly question: string; readonly passed: boolean; readonly normalizedPassed: boolean; readonly latencyMs: number }[];
  }>("benchmark-locomo.js", "locomo-", 20 * 60 * 1000, {
    BRAIN_LOCOMO_SAMPLE_CONVERSATIONS: "4",
    BRAIN_LOCOMO_SAMPLE_QUESTIONS: "10",
    BRAIN_LOCOMO_STRATIFIED: "1",
    BRAIN_LOCOMO_CATEGORY_LIMIT: "2"
  });

  const counselingRow = loCoMo.report?.results?.find((row) =>
    row.question.includes("Would Caroline still want to pursue counseling as a career if she hadn't received support growing up?")
  );

  const buildGate = (
    name: string,
    execution: BenchmarkLaneExecution<unknown>,
    passed: boolean,
    detail: string
  ): ThreeLaneGate => {
    const laneStatus =
      execution.timedOut ? "timed_out" :
      execution.exitCode !== 0 ? "process_failed" :
      !execution.artifactDetected ? "artifact_missing" :
      passed ? "passed" : "failed";
    const failureSuffix =
      passed
        ? ""
        : ` | ${summarizeFailureOutput(execution.stdout, execution.stderr)}`;
    return {
      name,
      passed,
      artifactPath: execution.jsonPath,
      artifactDetected: execution.artifactDetected,
      detail: `${detail}${failureSuffix}`,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      laneStatus
    };
  };

  const gliner2Utility = omiExtraction.report?.extractorSummaries.find((entry) => entry.extractor === "gliner2")?.utilityScore ?? null;
  const glinerRelexUtility = omiExtraction.report?.extractorSummaries.find((entry) => entry.extractor === "gliner_relex")?.utilityScore ?? null;
  const personalSummary = personalOmi.report?.summary;
  const omiWatchQueryCount = omiWatch.report?.queries.length ?? 0;

  const gates: ThreeLaneGate[] = [
    buildGate(
      "omi_extraction_shadow",
      omiExtraction,
      Boolean(
        omiExtraction.artifactDetected &&
        omiExtraction.exitCode === 0 &&
        omiExtraction.report?.passed &&
        typeof gliner2Utility === "number" &&
        typeof glinerRelexUtility === "number" &&
        gliner2Utility > glinerRelexUtility
      ),
      `gliner2 utility=${gliner2Utility ?? "n/a"} gliner_relex utility=${glinerRelexUtility ?? "n/a"}`
    ),
    buildGate(
      "personal_omi_review",
      personalOmi,
      Boolean(
        personalOmi.artifactDetected &&
        personalOmi.exitCode === 0 &&
        personalSummary &&
        personalSummary.pass >= 29 &&
        personalSummary.warning === 0 &&
        personalSummary.fail === 0 &&
        personalSummary.wrongClaimWithGoodEvidence === 0
      ),
      personalSummary
        ? `pass=${personalSummary.pass} warning=${personalSummary.warning} fail=${personalSummary.fail} wrongClaimWithGoodEvidence=${personalSummary.wrongClaimWithGoodEvidence}`
        : "summary unavailable"
    ),
    buildGate(
      "omi_watch",
      omiWatch,
      Boolean(
        omiWatch.artifactDetected &&
        omiWatch.exitCode === 0 &&
        omiWatch.report?.passed &&
        omiWatchQueryCount === 9 &&
        omiWatch.report?.blockedStage === null
      ),
      `queriesPassed=${omiWatchQueryCount}/9 blockedStage=${omiWatch.report?.blockedStage ?? "null"} graphPassed=${omiWatch.report?.graph.passed ?? false}`
    ),
    buildGate(
      "longmemeval",
      longMemEval,
      Boolean(longMemEval.artifactDetected && longMemEval.exitCode === 0 && (longMemEval.report?.passRate ?? 0) >= 0.875),
      `passRate=${longMemEval.report?.passRate ?? "n/a"} sampleCount=${longMemEval.report?.sampleCount ?? "n/a"}`
    ),
    buildGate(
      "locomo_targeted_slice",
      loCoMo,
      Boolean(
        loCoMo.artifactDetected &&
        loCoMo.exitCode === 0 &&
        (loCoMo.report?.passRate ?? 0) >= 0.95 &&
        counselingRow?.passed === true &&
        counselingRow?.normalizedPassed === true
      ),
      `passRate=${loCoMo.report?.passRate ?? "n/a"} sampleCount=${loCoMo.report?.sampleCount ?? "n/a"} counselingLatencyMs=${counselingRow?.latencyMs ?? "n/a"}`
    )
  ];
  const gateByName = new Map(gates.map((gate) => [gate.name, gate]));
  const groupPassed = (names: readonly string[]): boolean => names.every((name) => gateByName.get(name)?.passed === true);
  const laneGroups: Gliner2ThreeLaneMiniReport["laneGroups"] = {
    extractor_gate: {
      passed: groupPassed(["omi_extraction_shadow"]),
      gates: ["omi_extraction_shadow"]
    },
    product_gate: {
      passed: groupPassed(["personal_omi_review", "omi_watch"]),
      gates: ["personal_omi_review", "omi_watch"]
    },
    stress_gate: {
      passed: groupPassed(["longmemeval", "locomo_targeted_slice"]),
      gates: ["longmemeval", "locomo_targeted_slice"]
    }
  };

  const report: Gliner2ThreeLaneMiniReport = {
    generatedAt: new Date().toISOString(),
    releaseInterpretation: {
      omi: "primary product gate",
      longMemEval: "public generalization gate",
      locomo: "stress regression gate"
    },
    laneGroups,
    gates,
    passed: gates.every((gate) => gate.passed)
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `gliner2-three-lane-mini-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `gliner2-three-lane-mini-${stamp}.md`);
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

export async function runGliner2ThreeLaneMiniBenchmarkCli(): Promise<void> {
  const result = await runAndWriteGliner2ThreeLaneMiniBenchmark();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
