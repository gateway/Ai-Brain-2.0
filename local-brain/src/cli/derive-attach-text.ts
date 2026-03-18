import { closePool } from "../db/client.js";
import { attachTextDerivation } from "../derivations/service.js";

interface Args {
  artifactId?: string;
  artifactObservationId?: string;
  sourceChunkId?: string;
  derivationType: string;
  text?: string;
  provider?: string;
  model?: string;
  outputDimensionality?: number;
  embed: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    derivationType: "text_proxy",
    embed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--embed") {
      args.embed = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--artifact-id") {
      args.artifactId = value;
    } else if (arg === "--artifact-observation-id") {
      args.artifactObservationId = value;
    } else if (arg === "--source-chunk-id") {
      args.sourceChunkId = value;
    } else if (arg === "--type") {
      args.derivationType = value;
    } else if (arg === "--text") {
      args.text = value;
    } else if (arg === "--provider") {
      args.provider = value;
    } else if (arg === "--model") {
      args.model = value;
    } else if (arg === "--dimensions") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric value for ${arg}`);
      }
      args.outputDimensionality = parsed;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    index += 1;
  }

  if (!args.artifactId || !args.text?.trim()) {
    throw new Error(
      "Usage: derive-attach-text --artifact-id <uuid> --text <text> [--type caption|ocr|text_proxy] [--artifact-observation-id <uuid>] [--source-chunk-id <uuid>] [--embed] [--provider gemini|openrouter] [--model <name>] [--dimensions <n>]"
    );
  }

  return args;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await attachTextDerivation({
      artifactId: args.artifactId!,
      artifactObservationId: args.artifactObservationId,
      sourceChunkId: args.sourceChunkId,
      derivationType: args.derivationType,
      text: args.text!,
      provider: args.provider,
      model: args.model,
      outputDimensionality: args.outputDimensionality,
      embed: args.embed
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
