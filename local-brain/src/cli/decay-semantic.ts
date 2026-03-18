import { closePool } from "../db/client.js";
import { runSemanticDecay } from "../jobs/semantic-decay.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly limit?: number;
  readonly inactivityHours?: number;
  readonly decayFactor?: number;
  readonly minimumScore?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let namespaceId = "personal";
  let limit: number | undefined;
  let inactivityHours: number | undefined;
  let decayFactor: number | undefined;
  let minimumScore: number | undefined;

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
    } else if (arg === "--inactivity-hours") {
      inactivityHours = Number(value);
    } else if (arg === "--decay-factor") {
      decayFactor = Number(value);
    } else if (arg === "--min-score") {
      minimumScore = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    namespaceId,
    limit,
    inactivityHours,
    decayFactor,
    minimumScore
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runSemanticDecay(args.namespaceId, {
      limit: args.limit,
      inactivityHours: args.inactivityHours,
      decayFactor: args.decayFactor,
      minimumScore: args.minimumScore
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
