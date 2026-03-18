import { closePool } from "../db/client.js";
import path from "node:path";
import { ingestArtifact } from "../ingest/worker.js";
import type { SourceType } from "../types.js";

interface ParsedArgs {
  readonly inputUri: string;
  readonly namespaceId: string;
  readonly sourceType: SourceType;
  readonly sourceChannel?: string;
  readonly capturedAt: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error("Usage: ingest-file <path> [--namespace <id>] [--source-type <type>] [--source-channel <channel>] [--captured-at <iso>]");
  }

  const inputUri = path.resolve(argv[0]);
  let namespaceId = "personal";
  let sourceType: SourceType = "markdown";
  let sourceChannel: string | undefined;
  let capturedAt = new Date().toISOString();

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
    } else if (arg === "--source-type") {
      sourceType = value as SourceType;
    } else if (arg === "--source-channel") {
      sourceChannel = value;
    } else if (arg === "--captured-at") {
      capturedAt = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  return {
    inputUri,
    namespaceId,
    sourceType,
    sourceChannel,
    capturedAt
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await ingestArtifact({
      inputUri: args.inputUri,
      namespaceId: args.namespaceId,
      sourceType: args.sourceType,
      sourceChannel: args.sourceChannel,
      capturedAt: args.capturedAt
    });

    console.log(
      JSON.stringify(
        {
          artifact: result.artifact,
          fragments: result.fragments.length,
          candidateWrites: result.candidateWrites.length,
          episodicInsertCount: result.episodicInsertCount
        },
        null,
        2
      )
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
