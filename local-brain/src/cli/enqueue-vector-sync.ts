import { enqueueVectorSyncBackfill } from "../jobs/vector-sync.js";

function parseArgs(argv: readonly string[]): {
  namespaceId: string;
  provider: string;
  model: string;
  outputDimensionality?: number;
  limit?: number;
} {
  const args = [...argv];
  const positional: string[] = [];
  const flags = new Map<string, string>();

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      break;
    }

    if (current.startsWith("--")) {
      const key = current.slice(2);
      const value = args.shift();
      if (!value || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value`);
      }
      flags.set(key, value);
      continue;
    }

    positional.push(current);
  }

  const namespaceId = flags.get("namespace") ?? positional[0];
  if (!namespaceId) {
    throw new Error("Usage: node dist/cli/enqueue-vector-sync.js --namespace <namespace> --provider <provider> --model <model> [--dimensions 1536] [--limit 500]");
  }

  const provider = flags.get("provider") ?? "openrouter";
  const model = flags.get("model") ?? "text-embedding-3-small";
  const outputDimensionality = flags.has("dimensions") ? Number(flags.get("dimensions")) : undefined;
  const limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;

  return {
    namespaceId,
    provider,
    model,
    outputDimensionality: Number.isFinite(outputDimensionality) ? outputDimensionality : undefined,
    limit: Number.isFinite(limit) ? limit : undefined
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await enqueueVectorSyncBackfill(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
