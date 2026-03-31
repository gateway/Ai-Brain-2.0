import { closePool } from "../db/client.js";
import { fileURLToPath } from "node:url";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const namespaceId = readFlag("--namespace-id");
  if (!namespaceId) {
    throw new Error("Usage: rebuild-typed-memory --namespace-id <namespace-id>");
  }

  try {
    const result = await rebuildTypedMemoryNamespace(namespaceId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
