import { closePool } from "../db/client.js";
import { getRelationships } from "../retrieval/service.js";

interface ParsedArgs {
  readonly entityName: string;
  readonly namespaceId: string;
  readonly predicate?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: relationships <entity-name> [--namespace <id>] [--predicate <name>] [--time-start <iso>] [--time-end <iso>] [--limit <n>]"
    );
  }

  const entityName = argv[0];
  let namespaceId = "personal";
  let predicate: string | undefined;
  let timeStart: string | undefined;
  let timeEnd: string | undefined;
  let limit: number | undefined;

  for (let index = 1; index < argv.length; index += 1) {
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
    } else if (arg === "--predicate") {
      predicate = value;
    } else if (arg === "--time-start") {
      timeStart = value;
    } else if (arg === "--time-end") {
      timeEnd = value;
    } else if (arg === "--limit") {
      limit = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    entityName,
    namespaceId,
    predicate,
    timeStart,
    timeEnd,
    limit
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await getRelationships(args);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
