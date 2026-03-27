import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

interface BenchmarkInvocationResult {
  readonly jsonPath: string;
  readonly markdownPath?: string;
  readonly summary?: {
    readonly pass?: number;
    readonly warning?: number;
    readonly fail?: number;
  };
  readonly passed?: boolean;
}

interface IterativeScanVariantReport {
  readonly mode: "off" | "relaxed_order";
  readonly maxScanTuples?: number;
  readonly publicMissPassed: boolean;
  readonly publicMissScenarioPasses: number;
  readonly publicMissScenarioTotal: number;
  readonly abstentionPass: number;
  readonly abstentionWarning: number;
  readonly abstentionFail: number;
}

export interface IterativeScanCompareReport {
  readonly generatedAt: string;
  readonly baseline: IterativeScanVariantReport;
  readonly iterative: IterativeScanVariantReport;
  readonly delta: {
    readonly publicMissScenarioPassDelta: number;
    readonly abstentionPassDelta: number;
    readonly abstentionFailDelta: number;
  };
  readonly durationMs: number;
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

async function runCli(
  cliFile: string,
  env: NodeJS.ProcessEnv
): Promise<BenchmarkInvocationResult> {
  const cliPath = path.resolve(localBrainRoot(), "dist", "cli", cliFile);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: localBrainRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI ${cliFile} failed with code ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as BenchmarkInvocationResult);
      } catch (error) {
        reject(new Error(`Failed to parse ${cliFile} output: ${stdout}\n${String(error)}`));
      }
    });
  });
}

async function loadVariantReport(mode: "off" | "relaxed_order"): Promise<IterativeScanVariantReport> {
  const baseEnv = { ...process.env };
  if (mode === "relaxed_order") {
    baseEnv.PGOPTIONS = `${baseEnv.PGOPTIONS ? `${baseEnv.PGOPTIONS} ` : ""}-c hnsw.iterative_scan=relaxed_order -c hnsw.max_scan_tuples=20000`;
    baseEnv.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE = "relaxed_order";
    baseEnv.BRAIN_PGVECTOR_MAX_SCAN_TUPLES = "20000";
  } else {
    delete baseEnv.BRAIN_PGVECTOR_ITERATIVE_SCAN_MODE;
    delete baseEnv.BRAIN_PGVECTOR_MAX_SCAN_TUPLES;
  }

  const publicMiss = await runCli("benchmark-public-memory-miss-regressions.js", baseEnv);
  const abstention = await runCli("benchmark-abstention-review.js", baseEnv);
  const publicMissReport = JSON.parse(await readFile(publicMiss.jsonPath, "utf8")) as {
    readonly passed: boolean;
    readonly results: readonly { readonly passed: boolean }[];
  };
  const abstentionReport = JSON.parse(await readFile(abstention.jsonPath, "utf8")) as {
    readonly summary: { readonly pass: number; readonly warning: number; readonly fail: number };
  };

  return {
    mode,
    maxScanTuples: mode === "relaxed_order" ? 20000 : undefined,
    publicMissPassed: publicMissReport.passed,
    publicMissScenarioPasses: publicMissReport.results.filter((item) => item.passed).length,
    publicMissScenarioTotal: publicMissReport.results.length,
    abstentionPass: abstentionReport.summary.pass,
    abstentionWarning: abstentionReport.summary.warning,
    abstentionFail: abstentionReport.summary.fail
  };
}

export async function runAndWriteIterativeScanCompareBenchmark(): Promise<{
  readonly report: IterativeScanCompareReport;
  readonly output: { readonly jsonPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const startedAt = performance.now();
  const baseline = await loadVariantReport("off");
  const iterative = await loadVariantReport("relaxed_order");
  const report: IterativeScanCompareReport = {
    generatedAt,
    baseline,
    iterative,
    delta: {
      publicMissScenarioPassDelta: iterative.publicMissScenarioPasses - baseline.publicMissScenarioPasses,
      abstentionPassDelta: iterative.abstentionPass - baseline.abstentionPass,
      abstentionFailDelta: iterative.abstentionFail - baseline.abstentionFail
    },
    durationMs: Number((performance.now() - startedAt).toFixed(2))
  };

  const jsonPath = path.join(outputDir(), `iterative-scan-compare-${stamp}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  return { report, output: { jsonPath } };
}

export async function runIterativeScanCompareBenchmarkCli(): Promise<void> {
  const { report, output } = await runAndWriteIterativeScanCompareBenchmark();
  process.stdout.write(`${JSON.stringify({ jsonPath: output.jsonPath, delta: report.delta }, null, 2)}\n`);
}
