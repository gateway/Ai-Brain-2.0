import { getProviderAdapter } from "../providers/registry.js";
import { ProviderError } from "../providers/types.js";

interface Args {
  provider?: string;
  text?: string;
  dimensions?: number;
  model?: string;
  mode?: "embed" | "classify";
  presetId?: string;
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
    if (value === "--mode") {
      const mode = argv[i + 1];
      if (mode === "embed" || mode === "classify") {
        args.mode = mode;
      }
      i += 1;
      continue;
    }
    if (value === "--preset") {
      args.presetId = argv[i + 1];
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

  if (args.mode === "classify") {
    const result = await adapter.classifyText({
      text: args.text ?? "Steve is friends with Gummi and works on Two-Way.",
      model: args.model,
      maxOutputTokens: 768,
      systemPrompt: "Return strict JSON only.",
      instruction: "Return strict JSON with entities, relationships, claims, and ambiguities.",
      metadata: {
        preset_id: args.presetId
      }
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          provider: result.provider,
          model: result.model,
          latencyMs: result.latencyMs,
          tokenUsage: result.tokenUsage,
          output: result.output,
          supports: adapter.supports
        },
        null,
        2
      )
    );
    return;
  }

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
