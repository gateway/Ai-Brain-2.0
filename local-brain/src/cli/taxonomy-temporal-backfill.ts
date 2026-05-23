import { closePool } from "../db/client.js";
import { runTaxonomyTemporalBackfill, writeTaxonomyTemporalBackfillReport } from "../taxonomy-temporal/backfill.js";
import type { ExtractionAssistantMode } from "../taxonomy-temporal/types.js";

function readFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPositiveInteger(flag: string): number | undefined {
  const value = readFlag(flag);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function readMode(value: string | undefined): ExtractionAssistantMode | undefined {
  if (value === "off" || value === "shadow" || value === "assist" || value === "strict_review") {
    return value;
  }
  return undefined;
}

async function main(): Promise<void> {
  const namespaceId = readFlag("--namespace-id");
  if (!namespaceId) {
    throw new Error(
      "Usage: taxonomy-temporal-backfill --namespace-id <namespace-id> [--limit n] [--source-type type] [--source-channel channel] [--source-uri-contains text] [--mode off|shadow|assist|strict_review] [--dry-run] [--include-processed] [--skip-gliner2] [--latest-first] [--include-boilerplate-chunks]"
    );
  }

  try {
    const report = await runTaxonomyTemporalBackfill({
      namespaceId,
      limit: readPositiveInteger("--limit"),
      sourceType: readFlag("--source-type"),
      sourceChannel: readFlag("--source-channel"),
      sourceUriContains: readFlag("--source-uri-contains"),
      mode: readMode(readFlag("--mode")),
      dryRun: process.argv.includes("--dry-run"),
      skipProcessed: !process.argv.includes("--include-processed"),
      skipGliner2: process.argv.includes("--skip-gliner2"),
      latestFirst: process.argv.includes("--latest-first"),
      includeBoilerplateChunks: process.argv.includes("--include-boilerplate-chunks")
    });
    const artifactPath = await writeTaxonomyTemporalBackfillReport(report);
    process.stdout.write(
      `${JSON.stringify(
        {
          artifactPath,
          summary: report.summary,
          qualityGate: report.qualityGate,
          persistenceCheck: report.persistenceCheck
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
  const message = error instanceof Error ? error.message : String(error);
  if (/relation "extraction_units" does not exist/u.test(message)) {
    process.stderr.write(
      "taxonomy-temporal backfill requires migration 063_taxonomy_temporal_assistant.sql. Run migrations before processing historical chunks.\n"
    );
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
