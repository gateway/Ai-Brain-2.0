import { closePool } from "../db/client.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly limit?: number;
  readonly acceptThreshold?: number;
  readonly rejectThreshold?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let namespaceId = "personal";
  let limit: number | undefined;
  let acceptThreshold: number | undefined;
  let rejectThreshold: number | undefined;

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
    } else if (arg === "--accept-threshold") {
      acceptThreshold = Number(value);
    } else if (arg === "--reject-threshold") {
      rejectThreshold = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    namespaceId,
    limit,
    acceptThreshold,
    rejectThreshold
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runRelationshipAdjudication(args.namespaceId, {
      limit: args.limit,
      acceptThreshold: args.acceptThreshold,
      rejectThreshold: args.rejectThreshold
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
