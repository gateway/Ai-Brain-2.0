import { closePool } from "../db/client.js";
import { resolveDedicatedBenchmarkDatabaseUrl } from "../benchmark/benchmark-jobs.js";
import { runLoCoMoOwnerPackCli } from "../benchmark/locomo-owner-pack.js";

if (!process.env.BRAIN_DATABASE_URL) {
  process.env.BRAIN_DATABASE_URL = resolveDedicatedBenchmarkDatabaseUrl();
  process.env.BRAIN_BENCHMARK_ISOLATED_DB ??= "1";
}

let exitCode = 0;
try {
  await runLoCoMoOwnerPackCli();
} catch (error) {
  exitCode = 1;
  throw error;
} finally {
  await closePool();
}
process.exit(exitCode);
