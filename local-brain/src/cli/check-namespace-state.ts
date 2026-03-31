import { closePool, queryRows } from "../db/client.js";
import { getTypedMemoryCounts } from "../typed-memory/service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

interface CountRow {
  readonly count: string;
}

async function count(table: string, namespaceId: string): Promise<number> {
  const rows = await queryRows<CountRow>(`SELECT COUNT(*)::text AS count FROM ${table} WHERE namespace_id = $1`, [namespaceId]);
  return Number(rows[0]?.count ?? "0");
}

async function main(): Promise<void> {
  const namespaceId = readFlag("--namespace-id");
  if (!namespaceId) {
    throw new Error("Usage: check-namespace-state --namespace-id <namespace-id>");
  }

  try {
    const [artifacts, episodic, entities, relationships, typed] = await Promise.all([
      count("artifacts", namespaceId),
      count("episodic_memory", namespaceId),
      count("entities", namespaceId),
      count("relationship_memory", namespaceId),
      getTypedMemoryCounts(namespaceId)
    ]);
    process.stdout.write(
      `${JSON.stringify(
        {
          namespaceId,
          artifacts,
          episodicMemory: episodic,
          entities,
          relationshipFacts: relationships,
          typed
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
