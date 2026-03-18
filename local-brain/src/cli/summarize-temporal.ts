import { closePool } from "../db/client.js";
import { runTemporalSummaryScaffold, type TemporalLayer } from "../jobs/temporal-summary.js";

interface ParsedArgs {
  readonly namespaceId: string;
  readonly layer: TemporalLayer;
  readonly lookbackDays?: number;
  readonly maxMembersPerNode?: number;
}

function parseLayer(value: string): TemporalLayer {
  if (value === "day" || value === "week" || value === "month" || value === "year") {
    return value;
  }
  throw new Error(`Invalid --layer value: ${value}. Expected day|week|month|year.`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let namespaceId = "personal";
  let layer: TemporalLayer = "day";
  let lookbackDays: number | undefined;
  let maxMembersPerNode: number | undefined;

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
    } else if (arg === "--layer") {
      layer = parseLayer(value);
    } else if (arg === "--lookback-days") {
      lookbackDays = Number(value);
    } else if (arg === "--max-members") {
      maxMembersPerNode = Number(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    namespaceId,
    layer,
    lookbackDays,
    maxMembersPerNode
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runTemporalSummaryScaffold(args.namespaceId, {
      layer: args.layer,
      lookbackDays: args.lookbackDays,
      maxMembersPerNode: args.maxMembersPerNode
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
