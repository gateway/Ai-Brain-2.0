export type ProductionFailureCategory =
  | "wrong_claim_with_good_evidence"
  | "missing_evidence"
  | "weak_provenance"
  | "entity_resolution_error"
  | "temporal_resolution_error"
  | "task_extraction_error"
  | "continuity_pack_error"
  | "clarification_closure_error"
  | "atlas_truth_error";

export const PRODUCTION_FAILURE_CATEGORIES: readonly ProductionFailureCategory[] = [
  "wrong_claim_with_good_evidence",
  "missing_evidence",
  "weak_provenance",
  "entity_resolution_error",
  "temporal_resolution_error",
  "task_extraction_error",
  "continuity_pack_error",
  "clarification_closure_error",
  "atlas_truth_error"
];

export function zeroFailureCategoryCounts(): Record<ProductionFailureCategory, number> {
  return {
    wrong_claim_with_good_evidence: 0,
    missing_evidence: 0,
    weak_provenance: 0,
    entity_resolution_error: 0,
    temporal_resolution_error: 0,
    task_extraction_error: 0,
    continuity_pack_error: 0,
    clarification_closure_error: 0,
    atlas_truth_error: 0
  };
}

export function countFailureCategories(
  items: ReadonlyArray<{
    readonly failureCategories?: readonly ProductionFailureCategory[];
  }>
): Record<ProductionFailureCategory, number> {
  const counts = zeroFailureCategoryCounts();
  for (const item of items) {
    for (const category of item.failureCategories ?? []) {
      counts[category] += 1;
    }
  }
  return counts;
}

export function normalizeScore(passed: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number(((passed / total) * 100).toFixed(2));
}

export function weightedProductionScore(input: {
  readonly continuity: number;
  readonly personalRecall: number;
  readonly mcpQuality: number;
  readonly dbRuntime: number;
  readonly benchmarkSafety: number;
}): number {
  return Number(
    (
      input.continuity * 0.3 +
      input.personalRecall * 0.3 +
      input.mcpQuality * 0.2 +
      input.dbRuntime * 0.1 +
      input.benchmarkSafety * 0.1
    ).toFixed(2)
  );
}
