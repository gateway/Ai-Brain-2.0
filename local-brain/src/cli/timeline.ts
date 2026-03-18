import { closePool } from "../db/client.js";
import { timelineMemory } from "../retrieval/service.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly limit?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let namespaceId = "personal";
  let timeStart: string | undefined;
  let timeEnd: string | undefined;
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

  if (!timeStart || !timeEnd) {
    throw new Error("Usage: timeline --time-start <iso> --time-end <iso> [--namespace <id>] [--limit <n>]");
  }

  return {
    namespaceId,
    timeStart,
    timeEnd,
    limit
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await timelineMemory(args);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
