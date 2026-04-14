import { withMaintenanceLock } from "../db/client.js";
import { resolveDedicatedBenchmarkDatabaseUrl } from "../benchmark/benchmark-jobs.js";
import { scrubResidualBenchmarkNamespaces } from "../benchmark/public-benchmark-cleanup.js";

interface JanitorArgs {
  readonly prefix: string;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly namespaceChunkSize?: number;
}

function parseArgs(argv: readonly string[]): JanitorArgs {
  let prefix = "benchmark_";
  let statementTimeoutMs: number | undefined;
  let lockTimeoutMs: number | undefined;
  let namespaceChunkSize: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1] ?? "";
    if (token === "--prefix") {
      prefix = next || prefix;
      index += 1;
      continue;
    }
    if (token === "--statement-timeout-ms") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        statementTimeoutMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
    if (token === "--lock-timeout-ms") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        lockTimeoutMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
    if (token === "--namespace-chunk-size") {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        namespaceChunkSize = Math.floor(parsed);
      }
      index += 1;
    }
  }

  return {
    prefix,
    statementTimeoutMs,
    lockTimeoutMs,
    namespaceChunkSize
  };
}

function log(message: string): void {
  process.stdout.write(`[benchmark-janitor] ${new Date().toISOString()} ${message}\n`);
}

const args = parseArgs(process.argv.slice(2));

if (!process.env.BRAIN_DATABASE_URL) {
  process.env.BRAIN_DATABASE_URL = resolveDedicatedBenchmarkDatabaseUrl();
  process.env.BRAIN_BENCHMARK_ISOLATED_DB ??= "1";
}

const result = await withMaintenanceLock("benchmark janitor", async () =>
  scrubResidualBenchmarkNamespaces(args.prefix, {
    namespaceChunkSize: args.namespaceChunkSize,
    statementTimeoutMs: args.statementTimeoutMs,
    lockTimeoutMs: args.lockTimeoutMs,
    logger: log
  })
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
