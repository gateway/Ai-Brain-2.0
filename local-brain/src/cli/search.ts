import { closePool } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: search <query> [--namespace <id>] [--time-start <iso>] [--time-end <iso>] [--limit <n>] [--provider openrouter|gemini] [--model <name>] [--dimensions <n>]"
    );
  }

  let namespaceId = "personal";
  let timeStart: string | undefined;
  let timeEnd: string | undefined;
  let limit: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let outputDimensionality: number | undefined;
  const queryParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      queryParts.push(arg);
      continue;
    }

    const value = argv[index + 1];
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
    } else if (arg === "--provider") {
      provider = value;
    } else if (arg === "--model") {
      model = value;
    } else if (arg === "--dimensions") {
      outputDimensionality = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("Search query cannot be empty.");
  }

  return {
    namespaceId,
    query,
    timeStart,
    timeEnd,
    limit,
    provider,
    model,
    outputDimensionality
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await searchMemory(args);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
