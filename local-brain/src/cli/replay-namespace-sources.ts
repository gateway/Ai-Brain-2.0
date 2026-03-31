import { closePool, queryRows, withMaintenanceLock } from "../db/client.js";
import { fileURLToPath } from "node:url";
import { importMonitoredSource, scanMonitoredSource } from "../ops/source-service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

interface SourceRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly root_path: string;
}

export async function replayNamespaceSources(
  namespaceId: string,
  options: {
    readonly triggerType?: "manual" | "scheduled" | "onboarding";
    readonly forceImport?: boolean;
  } = {}
): Promise<{
  readonly namespaceId: string;
  readonly triggerType: "manual" | "scheduled" | "onboarding";
  readonly forceImport: boolean;
  readonly sourceCount: number;
  readonly replayed: readonly unknown[];
}> {
  const triggerType = options.triggerType ?? "manual";
  const force = options.forceImport === true;
  const sourceRows = await queryRows<SourceRow>(
    `
      SELECT id, label, status, root_path
      FROM ops.monitored_sources
      WHERE namespace_id = $1
        AND status <> 'disabled'
      ORDER BY created_at ASC
    `,
    [namespaceId]
  );

  if (sourceRows.length === 0) {
    throw new Error(`No monitored sources found for namespace ${namespaceId}.`);
  }

  const replayed = await withMaintenanceLock(`replay namespace ${namespaceId}`, async () => {
    const outputs = [];
    for (const source of sourceRows) {
      const preview = await scanMonitoredSource(source.id);
      const imported = await importMonitoredSource(source.id, triggerType, undefined, { forceImport: force });
      outputs.push({
        source: {
          id: source.id,
          label: source.label,
          status: source.status,
          rootPath: source.root_path
        },
        preview: preview.preview,
        importRun: imported.importRun
      });
    }
    return outputs;
  });

  return {
    namespaceId,
    triggerType,
    forceImport: force,
    sourceCount: sourceRows.length,
    replayed
  };
}

async function main(): Promise<void> {
  const namespaceId = readFlag("--namespace-id");
  if (!namespaceId) {
    throw new Error("Usage: replay-namespace-sources --namespace-id <namespace-id> [--trigger-type manual|scheduled|onboarding] [--force]");
  }

  try {
    const result = await replayNamespaceSources(namespaceId, {
      triggerType: (readFlag("--trigger-type") as "manual" | "scheduled" | "onboarding" | undefined) ?? "manual",
      forceImport: process.argv.includes("--force")
    });
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
