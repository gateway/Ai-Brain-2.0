import { closePool } from "../db/client.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly limit?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let namespaceId = "personal";
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (!arg.startsWith("--")) {
      continue;
    }

    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--namespace") {
      namespaceId = value;
    } else if (arg === "--limit") {
      limit = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    namespaceId,
    limit
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runCandidateConsolidation(args.namespaceId, args.limit);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
