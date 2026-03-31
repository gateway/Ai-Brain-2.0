import { closePool } from "../db/client.js";
import { importMonitoredSource, scanMonitoredSource } from "../ops/source-service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const sourceId = readFlag("--source-id");
  if (!sourceId) {
    throw new Error("Usage: import-monitored-source --source-id <uuid> [--trigger-type manual|scheduled|onboarding] [--force]");
  }

  const triggerType = (readFlag("--trigger-type") as "manual" | "scheduled" | "onboarding" | undefined) ?? "manual";
  const force = process.argv.includes("--force");

  try {
    const preview = await scanMonitoredSource(sourceId);
    const imported = await importMonitoredSource(sourceId, triggerType, undefined, { forceImport: force });

    process.stdout.write(
      `${JSON.stringify(
        {
          source: imported.source,
          importRun: imported.importRun,
          preview: preview.preview,
          forceImport: force
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
