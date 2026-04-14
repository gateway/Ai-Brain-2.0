import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMaintenanceLockHolders, terminateMaintenanceLockHolder } from "../db/client.js";

export type BenchmarkJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type BenchmarkJobName =
  | "locomo"
  | "locomo-mini"
  | "locomo-standard"
  | "locomo-release-candidate"
  | "certification-98";

export interface BenchmarkJobRecord {
  readonly runId: string;
  readonly benchmarkName: BenchmarkJobName;
  readonly status: BenchmarkJobStatus;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly logPath: string;
  readonly artifactPath: string | null;
  readonly markdownPath: string | null;
  readonly statusPath: string;
  readonly error: string | null;
  readonly envOverrides: Readonly<Record<string, string>>;
}

export interface BenchmarkJobTarget {
  readonly benchmarkName: BenchmarkJobName;
  readonly env: Readonly<Record<string, string>>;
}

export interface MaintenanceLockHolderSnapshot {
  readonly backendPid: number;
  readonly applicationName: string | null;
  readonly state: string | null;
  readonly queryStart: string | null;
}

export interface CleanupStaleBenchmarkJobsResult {
  readonly staleJobIds: readonly string[];
  readonly terminatedLockHolderPids: readonly number[];
  readonly activeLockHolders: readonly MaintenanceLockHolderSnapshot[];
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

export function benchmarkJobsDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-jobs");
}

export function benchmarkJobLogsDir(): string {
  return path.join(benchmarkJobsDir(), "logs");
}

export function benchmarkJobStatusPath(runId: string): string {
  return path.join(benchmarkJobsDir(), `${runId}.json`);
}

export function benchmarkJobLogPath(runId: string): string {
  return path.join(benchmarkJobLogsDir(), `${runId}.log`);
}

export async function ensureBenchmarkJobsDirs(): Promise<void> {
  await mkdir(benchmarkJobLogsDir(), { recursive: true });
}

export function createBenchmarkRunId(benchmarkName: BenchmarkJobName): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${benchmarkName}-${stamp}`;
}

export function resolveDedicatedBenchmarkDatabaseUrl(): string {
  return process.env.BRAIN_BENCHMARK_DATABASE_URL?.trim() || "postgresql:///ai_brain_benchmark";
}

export function resolveBenchmarkJobTarget(
  benchmarkName: BenchmarkJobName,
  envOverrides: Readonly<Record<string, string>> = {}
): BenchmarkJobTarget {
  const baseEnv: Record<string, string> = {};
  const dedicatedBenchmarkDatabaseUrl = resolveDedicatedBenchmarkDatabaseUrl();
  switch (benchmarkName) {
    case "locomo-mini":
      baseEnv.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS = "4";
      baseEnv.BRAIN_LOCOMO_SAMPLE_QUESTIONS = "10";
      baseEnv.BRAIN_LOCOMO_STRATIFIED = "1";
      baseEnv.BRAIN_LOCOMO_CATEGORY_LIMIT = "2";
      break;
    case "locomo-standard":
      baseEnv.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS = "10";
      baseEnv.BRAIN_LOCOMO_SAMPLE_QUESTIONS = "10";
      baseEnv.BRAIN_LOCOMO_STRATIFIED = "1";
      baseEnv.BRAIN_LOCOMO_CATEGORY_LIMIT = "2";
      break;
    case "locomo-release-candidate":
      baseEnv.BRAIN_LOCOMO_SAMPLE_CONVERSATIONS = "10";
      baseEnv.BRAIN_LOCOMO_SAMPLE_QUESTIONS = "15";
      baseEnv.BRAIN_LOCOMO_STRATIFIED = "1";
      baseEnv.BRAIN_LOCOMO_CATEGORY_LIMIT = "3";
      break;
    case "locomo":
    case "certification-98":
      break;
    default:
      assertNever(benchmarkName);
  }
  if (dedicatedBenchmarkDatabaseUrl) {
    baseEnv.BRAIN_DATABASE_URL = dedicatedBenchmarkDatabaseUrl;
    baseEnv.BRAIN_BENCHMARK_ISOLATED_DB = "1";
  }
  return {
    benchmarkName,
    env: { ...baseEnv, ...envOverrides }
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported benchmark job target: ${String(value)}`);
}

export async function writeBenchmarkJobRecord(record: BenchmarkJobRecord): Promise<void> {
  await ensureBenchmarkJobsDirs();
  await writeFile(record.statusPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readBenchmarkJobRecord(statusPath: string): Promise<BenchmarkJobRecord | null> {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw) as BenchmarkJobRecord;
  } catch {
    return null;
  }
}

export async function readBenchmarkJobRecordById(runId: string): Promise<BenchmarkJobRecord | null> {
  return readBenchmarkJobRecord(benchmarkJobStatusPath(runId));
}

export async function listBenchmarkJobRecords(): Promise<readonly BenchmarkJobRecord[]> {
  await ensureBenchmarkJobsDirs();
  const entries = await readdir(benchmarkJobsDir(), { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readBenchmarkJobRecord(path.join(benchmarkJobsDir(), entry.name)))
  );
  return records
    .filter((record): record is BenchmarkJobRecord => record !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function isProcessAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findActiveBenchmarkJob(): Promise<BenchmarkJobRecord | null> {
  const records = await listBenchmarkJobRecords();
  const active = [...records].reverse().find((record) => record.status === "running" && isProcessAlive(record.pid));
  return active ?? null;
}

function hasStatusFile(statusPath: string): boolean {
  try {
    accessSync(statusPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupStaleBenchmarkJobs(): Promise<CleanupStaleBenchmarkJobsResult> {
  const staleJobIds: string[] = [];
  const terminatedLockHolderPids: number[] = [];
  const records = await listBenchmarkJobRecords();
  for (const record of records) {
    if (record.status !== "running") {
      continue;
    }
    if (isProcessAlive(record.pid)) {
      continue;
    }
    const staleRecord: BenchmarkJobRecord = {
      ...record,
      status: "failed",
      completedAt: record.completedAt ?? new Date().toISOString(),
      error: record.error ?? "Runner exited without completing the benchmark job."
    };
    staleJobIds.push(record.runId);
    if (hasStatusFile(staleRecord.statusPath)) {
      await writeBenchmarkJobRecord(staleRecord);
    }
  }

  const activeLockHolders = await getMaintenanceLockHolders();
  for (const holder of activeLockHolders) {
    const applicationName = holder.applicationName ?? "";
    const match = applicationName.match(/^brain-benchmark-job:(.+)$/u);
    if (!match) {
      continue;
    }
    const runId = match[1];
    const record = records.find((candidate) => candidate.runId === runId);
    if (!record) {
      const terminated = await terminateMaintenanceLockHolder(holder.backendPid);
      if (terminated) {
        terminatedLockHolderPids.push(holder.backendPid);
      }
      continue;
    }
    if (record.status === "running" && !isProcessAlive(record.pid)) {
      const terminated = await terminateMaintenanceLockHolder(holder.backendPid);
      if (terminated) {
        terminatedLockHolderPids.push(holder.backendPid);
      }
    }
  }

  return {
    staleJobIds,
    terminatedLockHolderPids,
    activeLockHolders: await getMaintenanceLockHolders()
  };
}
