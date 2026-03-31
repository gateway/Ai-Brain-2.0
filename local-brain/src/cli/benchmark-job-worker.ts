import { closePool } from "../db/client.js";
import {
  benchmarkJobLogPath,
  benchmarkJobStatusPath,
  readBenchmarkJobRecordById,
  type BenchmarkJobName,
  type BenchmarkJobRecord
} from "../benchmark/benchmark-jobs.js";
import { runAndWriteCertification98 } from "../benchmark/certification-98.js";
import { runAndWriteLoCoMoBenchmark } from "../benchmark/locomo.js";

interface WorkerArgs {
  readonly runId: string;
  readonly benchmarkName: BenchmarkJobName;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  let runId: string | null = null;
  let benchmarkName: BenchmarkJobName | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-id") {
      runId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === "--benchmark") {
      benchmarkName = (argv[index + 1] ?? null) as BenchmarkJobName | null;
      index += 1;
    }
  }
  if (!runId || !benchmarkName) {
    throw new Error("Usage: benchmark-job-worker --run-id <id> --benchmark <name>");
  }
  return { runId, benchmarkName };
}

async function updateStatus(
  runId: string,
  mutate: (record: BenchmarkJobRecord) => BenchmarkJobRecord
): Promise<void> {
  const existing = await readBenchmarkJobRecordById(runId);
  if (!existing) {
    throw new Error(`Benchmark job record not found for runId=${runId}`);
  }
  await writeStatus(mutate(existing));
}

async function writeStatus(record: BenchmarkJobRecord): Promise<void> {
  const { writeBenchmarkJobRecord } = await import("../benchmark/benchmark-jobs.js");
  await writeBenchmarkJobRecord(record);
}

async function runSelectedBenchmark(benchmarkName: BenchmarkJobName): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string | null;
}> {
  switch (benchmarkName) {
    case "locomo":
    case "locomo-mini":
    case "locomo-standard":
    case "locomo-release-candidate": {
      const { output } = await runAndWriteLoCoMoBenchmark();
      return { jsonPath: output.jsonPath, markdownPath: output.markdownPath };
    }
    case "certification-98": {
      const { output } = await runAndWriteCertification98();
      return { jsonPath: output.jsonPath, markdownPath: output.markdownPath };
    }
    default:
      return assertNever(benchmarkName);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported benchmark worker target: ${String(value)}`);
}

const args = parseWorkerArgs(process.argv.slice(2));

try {
  await updateStatus(args.runId, (record) => ({
    ...record,
    status: "running",
    pid: process.pid,
    logPath: record.logPath || benchmarkJobLogPath(args.runId),
    statusPath: record.statusPath || benchmarkJobStatusPath(args.runId),
    error: null
  }));

  const artifact = await runSelectedBenchmark(args.benchmarkName);
  await updateStatus(args.runId, (record) => ({
    ...record,
    status: "completed",
    pid: process.pid,
    completedAt: new Date().toISOString(),
    artifactPath: artifact.jsonPath,
    markdownPath: artifact.markdownPath,
    error: null
  }));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await updateStatus(args.runId, (record) => ({
    ...record,
    status: "failed",
    pid: process.pid,
    completedAt: new Date().toISOString(),
    error: message
  }));
  throw error;
} finally {
  await closePool();
}
