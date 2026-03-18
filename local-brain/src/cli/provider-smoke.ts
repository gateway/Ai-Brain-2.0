import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";

interface Args {
  provider?: string;
  text?: string;
  dimensions?: number;
  model?: string;
}

function readArgs(argv: readonly string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value) {
      continue;
    }
    if (value === "--provider") {
      args.provider = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--text") {
      args.text = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--dimensions") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed)) {
        args.dimensions = parsed;
      }
      i += 1;
      continue;
    }
    if (value === "--model") {
      args.model = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const provider = args.provider;
  const adapter = getProviderAdapter(provider);

  const result = await adapter.embedText({
    text: args.text ?? "Provider smoke check for Local Brain 2.0",
    outputDimensionality: args.dimensions,
    model: args.model
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: result.provider,
        model: result.model,
        dimensions: result.dimensions,
        latencyMs: result.latencyMs,
        embeddingPreview: result.embedding.slice(0, 8),
        supports: adapter.supports
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  if (error instanceof ProviderError) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          provider: error.provider,
          code: error.code,
          statusCode: error.statusCode,
          retryable: error.retryable,
          message: error.message
        },
        null,
        2
      )
    );
    process.exitCode = 2;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Provider smoke failed");
  }
  process.exitCode = 1;
});
