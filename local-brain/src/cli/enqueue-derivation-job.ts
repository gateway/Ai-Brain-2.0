import { closePool } from "../db/client.js";
import { enqueueDerivationJob } from "../jobs/derivation-queue.js";

interface Args {
  readonly namespaceId: string;
  readonly artifactId: string;
  readonly artifactObservationId?: string;
  readonly sourceChunkId?: string;
  readonly jobKind?: string;
  readonly modality?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly outputDimensionality?: number;
  readonly maxOutputTokens?: number;
}

function parseArgs(argv: readonly string[]): Args {
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
  const artifactId = flags.get("artifact-id") ?? positional[1];

  if (!namespaceId || !artifactId) {
    throw new Error(
      "Usage: derive:queue --namespace <namespace> --artifact-id <uuid> [--artifact-observation-id <uuid>] [--source-chunk-id <uuid>] [--job-kind ocr|transcription|caption|summary|derive_text|embed] [--modality text|image|pdf|audio|video] [--provider external] [--model <name>] [--dimensions <n>] [--max-output-tokens <n>]"
    );
  }

  const outputDimensionality = flags.has("dimensions") ? Number(flags.get("dimensions")) : undefined;
  const maxOutputTokens = flags.has("max-output-tokens") ? Number(flags.get("max-output-tokens")) : undefined;

  return {
    namespaceId,
    artifactId,
    artifactObservationId: flags.get("artifact-observation-id") ?? undefined,
    sourceChunkId: flags.get("source-chunk-id") ?? undefined,
    jobKind: flags.get("job-kind") ?? undefined,
    modality: flags.get("modality") ?? undefined,
    provider: flags.get("provider") ?? undefined,
    model: flags.get("model") ?? undefined,
    outputDimensionality: Number.isFinite(outputDimensionality) ? outputDimensionality : undefined,
    maxOutputTokens: Number.isFinite(maxOutputTokens) ? maxOutputTokens : undefined
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await enqueueDerivationJob({
      namespaceId: args.namespaceId,
      artifactId: args.artifactId,
      artifactObservationId: args.artifactObservationId,
      sourceChunkId: args.sourceChunkId,
      jobKind: args.jobKind as never,
      modality: args.modality as never,
      provider: args.provider,
      model: args.model,
      outputDimensionality: args.outputDimensionality,
      maxOutputTokens: args.maxOutputTokens
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
