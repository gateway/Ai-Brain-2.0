import path from "node:path";
import { readFile } from "node:fs/promises";
import { closePool } from "../db/client.js";
import { ingestWebhookPayload } from "../producers/webhook.js";
import type { ProducerProvider } from "../producers/types.js";

interface ParsedArgs {
  readonly payloadPath: string;
  readonly namespaceId: string;
  readonly provider: ProducerProvider;
  readonly sourceChannel?: string;
  readonly capturedAt?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new Error(
      "Usage: ingest-webhook <payload.json> [--namespace <id>] [--provider generic|slack|discord] [--source-channel <name>] [--captured-at <iso>]"
    );
  }

  const payloadPath = path.resolve(argv[0]);
  let namespaceId = "personal";
  let provider: ProducerProvider = "generic";
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
    } else if (arg === "--provider") {
      if (value !== "generic" && value !== "slack" && value !== "discord") {
        throw new Error(`Invalid provider: ${value}`);
      }
      provider = value;
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
    payloadPath,
    namespaceId,
    provider,
    sourceChannel,
    capturedAt
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const payloadRaw = await readFile(args.payloadPath, "utf8");
    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;

    const result = await ingestWebhookPayload({
      namespaceId: args.namespaceId,
      provider: args.provider,
      payload,
      sourceChannel: args.sourceChannel,
      capturedAt: args.capturedAt
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

