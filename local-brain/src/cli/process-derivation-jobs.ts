import { closePool } from "../db/client.js";
import { processDerivationJobs } from "../jobs/derivation-queue.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  try {
    const result = await processDerivationJobs({
      namespaceId: readFlag("--namespace"),
      provider: readFlag("--provider"),
      workerId: readFlag("--worker-id"),
      limit: readFlag("--limit") ? Number(readFlag("--limit")) : undefined
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
