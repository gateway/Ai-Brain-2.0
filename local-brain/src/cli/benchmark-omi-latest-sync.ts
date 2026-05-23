import { closePool } from "../db/client.js";
import { runOmiLatestSync } from "../benchmark/omi-latest-sync.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPositiveInteger(flag: string): number | undefined {
  const value = readFlag(flag);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function main(): Promise<void> {
  try {
    const result = await runOmiLatestSync({
      sourceId: readFlag("--source-id"),
      namespaceId: readFlag("--namespace-id"),
      compilerLimit: readPositiveInteger("--compiler-limit"),
      persistCompiler: process.argv.includes("--persist-compiler"),
      forceImport: process.argv.includes("--force-import"),
      skipCompiler: process.argv.includes("--skip-compiler"),
      runSourceRelationIe: process.argv.includes("--run-source-relation-ie")
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          artifactPath: result.artifactPath,
          passed: result.report.passed,
          blockedStage: result.report.blockedStage,
          latestFile: result.report.latestFile,
          importRun: result.report.importRun,
          compilerDryRun: result.report.compilerDryRun,
          compilerPersist: result.report.compilerPersist,
          stageTimingsMs: result.report.stageTimingsMs
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
