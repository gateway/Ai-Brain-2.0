import { closePool } from "../db/client.js";
import { processScheduledMonitoredSources } from "../ops/source-service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function readBooleanFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  try {
    const result = await processScheduledMonitoredSources({
      sourceId: readFlag("--source-id"),
      limit: readFlag("--limit") ? Number(readFlag("--limit")) : undefined,
      importAfterScan: !readBooleanFlag("--scan-only")
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
