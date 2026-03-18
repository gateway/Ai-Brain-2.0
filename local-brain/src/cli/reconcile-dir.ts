import path from "node:path";
import { closePool } from "../db/client.js";
import { reconcileDirectory } from "../ingest/reconcile.js";
import type { SourceType } from "../types.js";

interface ParsedArgs {
  readonly rootDir: string;
  readonly namespaceId: string;
  readonly sourceType: SourceType;
  readonly sourceChannel?: string;
  readonly capturedAt?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: reconcile-dir <dir> [--namespace <id>] [--source-type <type>] [--source-channel <channel>] [--captured-at <iso>]"
    );
  }

  const rootDir = path.resolve(argv[0]);
  let namespaceId = "personal";
  let sourceType: SourceType = "markdown_session";
  let sourceChannel: string | undefined;
  let capturedAt: string | undefined;

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
    rootDir,
    namespaceId,
    sourceType,
    sourceChannel,
    capturedAt
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await reconcileDirectory(args);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
