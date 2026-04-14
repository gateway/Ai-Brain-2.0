import { closePool } from "../db/client.js";
import { resolveDedicatedBenchmarkDatabaseUrl } from "../benchmark/benchmark-jobs.js";
import { runLoCoMoBenchmarkCli } from "../benchmark/locomo.js";

if (!process.env.BRAIN_DATABASE_URL) {
  process.env.BRAIN_DATABASE_URL = resolveDedicatedBenchmarkDatabaseUrl();
  process.env.BRAIN_BENCHMARK_ISOLATED_DB ??= "1";
}

try {
  await runLoCoMoBenchmarkCli();
} finally {
  await closePool();
}
