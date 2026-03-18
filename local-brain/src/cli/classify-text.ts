import { readFile } from "node:fs/promises";
import { classifyDerivationTextToCandidates, classifyTextToCandidates } from "../classification/service.js";

interface Args {
  namespaceId?: string;
  text?: string;
  file?: string;
  derivationId?: string;
  provider?: string;
  model?: string;
  presetId?: string;
  maxTokens?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const result: Partial<Args> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!arg?.startsWith("--")) {
      continue;
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--namespace") result.namespaceId = value;
    else if (arg === "--text") result.text = value;
    else if (arg === "--file") result.file = value;
    else if (arg === "--derivation-id") result.derivationId = value;
    else if (arg === "--provider") result.provider = value;
    else if (arg === "--model") result.model = value;
    else if (arg === "--preset") result.presetId = value;
    else if (arg === "--max-tokens") result.maxTokens = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }

  return result;
}

async function resolveText(args: Args): Promise<string> {
  if (args.text?.trim()) {
    return args.text.trim();
  }
  if (args.file) {
    return (await readFile(args.file, "utf8")).trim();
  }
  throw new Error("Provide --text, --file, or --derivation-id.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const result = args.derivationId
    ? await classifyDerivationTextToCandidates({
        derivationId: args.derivationId,
        provider: args.provider,
        model: args.model,
        presetId: args.presetId,
        maxOutputTokens: args.maxTokens
      })
    : await classifyTextToCandidates({
        namespaceId: args.namespaceId ?? "personal",
        text: await resolveText(args),
        provider: args.provider,
        model: args.model,
        presetId: args.presetId,
        maxOutputTokens: args.maxTokens
      });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Classification failed");
  process.exitCode = 1;
});
