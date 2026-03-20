import { closePool } from "../db/client.js";
import { getBootstrapState, resolveRuntimeOperationsSettings } from "../ops/source-service.js";
import {
  buildRuntimeLoopWorkerId,
  executeOutboxWorker,
  executeSourceMonitorWorker,
  executeTemporalSummaryWorker
} from "../ops/runtime-worker-service.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(): Promise<{
  readonly checkedAt: string;
  readonly namespaceId: string;
  readonly sourceMonitor?: unknown;
  readonly outbox?: unknown;
  readonly temporalSummary?: unknown;
}> {
  const bootstrap = await getBootstrapState();
  const settings = resolveRuntimeOperationsSettings(bootstrap.metadata);
  const namespaceId =
    typeof bootstrap.metadata.defaultNamespaceId === "string" && bootstrap.metadata.defaultNamespaceId.trim()
      ? bootstrap.metadata.defaultNamespaceId
      : "personal";

  const result: {
    checkedAt: string;
    namespaceId: string;
    sourceMonitor?: unknown;
    outbox?: unknown;
    temporalSummary?: unknown;
  } = {
    checkedAt: new Date().toISOString(),
    namespaceId
  };

  if (settings.sourceMonitor.enabled) {
    result.sourceMonitor = await executeSourceMonitorWorker({
      importAfterScan: settings.sourceMonitor.autoImportOnScan,
      triggerType: "loop",
      workerId: buildRuntimeLoopWorkerId("source-monitor")
    });
  }

  result.outbox = await executeOutboxWorker({
    namespaceId,
    limit: settings.outbox.batchLimit,
    triggerType: "loop",
    workerId: buildRuntimeLoopWorkerId("outbox")
  });

  if (settings.temporalSummary.enabled) {
    result.temporalSummary = await executeTemporalSummaryWorker({
      namespaceId,
      lookbackDays: settings.temporalSummary.lookbackDays,
      strategy: settings.temporalSummary.strategy,
      provider: settings.temporalSummary.summarizerProvider,
      model: settings.temporalSummary.summarizerModel,
      presetId: settings.temporalSummary.summarizerPreset,
      systemPrompt: settings.temporalSummary.systemPrompt,
      triggerType: "loop",
      workerId: buildRuntimeLoopWorkerId("temporal-summary")
    });
  }

  return result;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const pollSeconds = readFlag("--poll-seconds") ? Number(readFlag("--poll-seconds")) : 5;

  try {
    if (once) {
      process.stdout.write(`${JSON.stringify(await runOnce(), null, 2)}\n`);
      return;
    }

    while (true) {
      const cycle = await runOnce();
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
      await sleep(Math.max(5, Number.isFinite(pollSeconds) ? pollSeconds : 5) * 1000);
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
