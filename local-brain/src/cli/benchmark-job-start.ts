import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  benchmarkJobLogPath,
  benchmarkJobStatusPath,
  cleanupStaleBenchmarkJobs,
  createBenchmarkRunId,
  ensureBenchmarkJobsDirs,
  findActiveBenchmarkJob,
  localBrainRoot,
  resolveBenchmarkJobTarget,
  writeBenchmarkJobRecord,
  type BenchmarkJobName
} from "../benchmark/benchmark-jobs.js";

interface StartArgs {
  readonly benchmarkName: BenchmarkJobName;
  readonly envOverrides: Readonly<Record<string, string>>;
}

function parseStartArgs(argv: readonly string[]): StartArgs {
  let benchmarkName: BenchmarkJobName | null = null;
  const envOverrides: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--benchmark") {
      benchmarkName = (argv[index + 1] ?? null) as BenchmarkJobName | null;
      index += 1;
      continue;
    }
    if (token === "--set") {
      const pair = argv[index + 1] ?? "";
      index += 1;
      const equalsIndex = pair.indexOf("=");
      if (equalsIndex <= 0) {
        throw new Error(`Invalid --set value ${JSON.stringify(pair)}. Expected NAME=value.`);
      }
      const name = pair.slice(0, equalsIndex).trim();
      const value = pair.slice(equalsIndex + 1);
      envOverrides[name] = value;
    }
  }
  if (!benchmarkName) {
    throw new Error("Usage: benchmark-job-start --benchmark <locomo-mini|locomo-standard|locomo-release-candidate|locomo|certification-98> [--set NAME=value]");
  }
  return { benchmarkName, envOverrides };
}

const args = parseStartArgs(process.argv.slice(2));
await ensureBenchmarkJobsDirs();
const cleanup = await cleanupStaleBenchmarkJobs();
const active = await findActiveBenchmarkJob();
if (active) {
  throw new Error(
    `A benchmark job is already running (${active.runId}, pid=${active.pid ?? "unknown"}). Check benchmark-job-status before starting another run.`
  );
}

const target = resolveBenchmarkJobTarget(args.benchmarkName, args.envOverrides);
const runId = createBenchmarkRunId(target.benchmarkName);
const statusPath = benchmarkJobStatusPath(runId);
const logPath = benchmarkJobLogPath(runId);
const startedAt = new Date().toISOString();

await writeBenchmarkJobRecord({
  runId,
  benchmarkName: target.benchmarkName,
  status: "queued",
  pid: null,
  startedAt,
  completedAt: null,
  logPath,
  artifactPath: null,
  markdownPath: null,
  statusPath,
  error: null,
  envOverrides: target.env
});

const logFd = openSync(logPath, "a");
const child = spawn(
  process.execPath,
  [path.resolve(localBrainRoot(), "dist/cli/benchmark-job-worker.js"), "--run-id", runId, "--benchmark", target.benchmarkName],
  {
    cwd: localBrainRoot(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ...target.env,
      PGAPPNAME: `brain-benchmark-job:${runId}`
    }
  }
);
child.unref();

await writeBenchmarkJobRecord({
  runId,
  benchmarkName: target.benchmarkName,
  status: "running",
  pid: child.pid ?? null,
  startedAt,
  completedAt: null,
  logPath,
  artifactPath: null,
  markdownPath: null,
  statusPath,
  error: null,
  envOverrides: target.env
});

process.stdout.write(
  `${JSON.stringify(
    {
      runId,
      benchmarkName: target.benchmarkName,
      pid: child.pid ?? null,
      statusPath,
      logPath,
      cleanup
    },
    null,
    2
  )}\n`
);
