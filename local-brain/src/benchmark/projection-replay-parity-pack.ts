import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProjectionPromotion, projectionReplaySignature } from "../contract-projections/promotion-policy.js";

const ROWS = [
  {
    id: "relationship_map_active",
    contractName: "relationship_map" as const,
    projectionKind: "report" as const,
    bundleKey: "person:steve|person:dan",
    truthStatus: "active" as const,
    completenessScore: 1,
    supportCount: 3,
    entryCount: 3,
    summaryText: "Dan relationship map",
    projectionVersion: "relationship_map_projection_v1",
    requiredFields: ["entries"],
    fulfilledFields: ["entries"]
  },
  {
    id: "relationship_chronology_missing_support",
    contractName: "relationship_chronology" as const,
    projectionKind: "report" as const,
    bundleKey: "person:steve|person:unknown",
    truthStatus: "active" as const,
    completenessScore: 0.5,
    supportCount: 0,
    entryCount: 0,
    summaryText: "unsupported chronology",
    projectionVersion: "relationship_chronology_projection_v1",
    requiredFields: ["entries"],
    fulfilledFields: []
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export async function runAndWriteProjectionReplayParityPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const first = ROWS.map((row) => ({
    ...row,
    promotion: evaluateProjectionPromotion(row),
    replaySignature: projectionReplaySignature(row)
  }));
  const second = ROWS.map((row) => ({
    ...row,
    promotion: evaluateProjectionPromotion(row),
    replaySignature: projectionReplaySignature(row)
  }));
  const rows = first.map((row, index) => ({
    id: row.id,
    firstSignature: row.replaySignature,
    secondSignature: second[index]!.replaySignature,
    promotionPolicyId: row.promotion.policyId,
    conflictStatus: row.promotion.conflictStatus,
    correctionOverlayStatus: row.promotion.correctionOverlayStatus,
    stopEligible: row.promotion.stopEligible,
    deterministic: row.replaySignature === second[index]!.replaySignature,
    passed: row.replaySignature === second[index]!.replaySignature && row.promotion.conflictStatus === "none" && row.promotion.correctionOverlayStatus === "none"
  }));
  const metrics = {
    projectionReplayParityRate: Number((rows.filter((row) => row.deterministic).length / rows.length).toFixed(4)),
    projectionSignatureCoverageRate: Number((rows.filter((row) => row.firstSignature.length === 64).length / rows.length).toFixed(4)),
    projectionConflictStatusCoverageRate: Number((rows.filter((row) => row.conflictStatus).length / rows.length).toFixed(4)),
    correctionOverlayStatusCoverageRate: Number((rows.filter((row) => row.correctionOverlayStatus).length / rows.length).toFixed(4)),
    unsupportedPromotionBlockedCount: rows.filter((row) => row.id.includes("missing_support") && row.stopEligible).length
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "projection_replay_parity_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.projectionReplayParityRate === 1 &&
      metrics.projectionSignatureCoverageRate === 1 &&
      metrics.projectionConflictStatusCoverageRate === 1 &&
      metrics.correctionOverlayStatusCoverageRate === 1 &&
      metrics.unsupportedPromotionBlockedCount === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `projection-replay-parity-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `projection-replay-parity-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Projection Replay Parity Pack\n\n- passed: ${report.passed}\n- projectionReplayParityRate: ${metrics.projectionReplayParityRate}\n- unsupportedPromotionBlockedCount: ${metrics.unsupportedPromotionBlockedCount}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runProjectionReplayParityPackCli(): Promise<void> {
  const { report, output } = await runAndWriteProjectionReplayParityPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
