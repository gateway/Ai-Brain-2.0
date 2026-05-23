import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLINER_RELEX_EXTRACTOR } from "../relationships/relex-schema.js";
import { evaluateGlinerRelexCrossIngestBakeoff } from "./gliner-relex-bakeoff.js";

function rootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

export async function runGlinerRelexPromotionDryRun(): Promise<{
  readonly generatedAt: string;
  readonly mode: "promotion_dry_run";
  readonly promotedCount: number;
  readonly rejectedCount: number;
  readonly rejectionBreakdown: Readonly<Record<string, number>>;
  readonly promotionWithoutSourceQuote: number;
  readonly unknownTaxonomyPromoted: number;
  readonly mixedOwnerPromoted: number;
  readonly coMentionOnlyPromoted: number;
  readonly queryTimeModelCalls: number;
  readonly passed: boolean;
  readonly artifactPath: string;
}> {
  const bakeoff = await evaluateGlinerRelexCrossIngestBakeoff();
  const relexRows = bakeoff.cases.flatMap((entry) => entry.extractors.filter((extractor) => extractor.extractor === GLINER_RELEX_EXTRACTOR));
  const rejectionBreakdown: Record<string, number> = {};
  for (const row of relexRows) {
    for (const [key, count] of Object.entries(row.rejectionBreakdown)) {
      rejectionBreakdown[key] = (rejectionBreakdown[key] ?? 0) + count;
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mode: "promotion_dry_run" as const,
    promotedCount: relexRows.reduce((sum, row) => sum + row.promotedCount, 0),
    rejectedCount: relexRows.reduce((sum, row) => sum + row.rejectedCount, 0),
    rejectionBreakdown,
    promotionWithoutSourceQuote: bakeoff.gates.promotionWithoutSourceQuote,
    unknownTaxonomyPromoted: bakeoff.gates.unknownTaxonomyPromoted,
    mixedOwnerPromoted: bakeoff.gates.mixedOwnerPromoted,
    coMentionOnlyPromoted: bakeoff.gates.coMentionOnlyPromoted,
    queryTimeModelCalls: bakeoff.gates.queryTimeModelCalls,
    passed: bakeoff.gates.promotionWithoutSourceQuote === 0 && bakeoff.gates.unknownTaxonomyPromoted === 0 && bakeoff.gates.mixedOwnerPromoted === 0 && bakeoff.gates.coMentionOnlyPromoted === 0,
    artifactPath: ""
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const artifactPath = path.join(outputDir(), `gliner-relex-promotion-dry-run-${stamp}.json`);
  const fullReport = { ...report, artifactPath };
  await writeFile(artifactPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
  return fullReport;
}

