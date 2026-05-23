import type { RetrievalLatencyBudget } from "./types.js";

export type BudgetedExpensiveStage = "planner_targeted_backfill" | "typed_lane_descent";

export function maxElapsedBeforeExpensiveStageMs(
  family: RetrievalLatencyBudget["family"],
  stageName: BudgetedExpensiveStage
): number {
  if (stageName === "planner_targeted_backfill") {
    switch (family) {
      case "exact_detail_scalar":
      case "temporal_event":
      case "relationship_profile":
      case "broad_preference_profile":
      case "sparse_profile_inference":
        return 3_500;
      case "broad_direct_fact":
      case "bounded_event_detail":
      case "support_network_reasoned":
      case "location_history":
      case "event_inventory":
        return 5_000;
      default:
        return 7_500;
    }
  }
  switch (family) {
    case "exact_detail_scalar":
    case "temporal_event":
    case "relationship_profile":
    case "broad_preference_profile":
    case "sparse_profile_inference":
      return 4_500;
    case "broad_direct_fact":
    case "bounded_event_detail":
    case "support_network_reasoned":
    case "location_history":
    case "event_inventory":
      return 6_500;
    default:
      return 8_500;
  }
}

export function maxPlannerTargetedBackfillSubqueries(family: RetrievalLatencyBudget["family"]): number {
  switch (family) {
    case "broad_direct_fact":
      return 0;
    case "exact_detail_scalar":
    case "temporal_event":
    case "relationship_profile":
    case "broad_preference_profile":
    case "sparse_profile_inference":
      return 1;
    case "bounded_event_detail":
    case "support_network_reasoned":
    case "location_history":
    case "event_inventory":
      return 2;
    default:
      return 1;
  }
}

export function planPlannerTargetedBackfillBudget(params: {
  readonly family: RetrievalLatencyBudget["family"];
  readonly elapsedMs: number;
  readonly subqueries: readonly string[];
}): {
  readonly allowed: boolean;
  readonly subqueries: readonly string[];
  readonly maxSubqueries: number;
  readonly exceededStage?: string;
  readonly decision?: string;
} {
  const elapsedBudget = maxElapsedBeforeExpensiveStageMs(params.family, "planner_targeted_backfill");
  if (params.elapsedMs > elapsedBudget) {
    return {
      allowed: false,
      subqueries: [],
      maxSubqueries: maxPlannerTargetedBackfillSubqueries(params.family),
      exceededStage: "planner_targeted_backfill",
      decision: `planner_targeted_backfill_skipped_after_${Math.round(params.elapsedMs)}ms`
    };
  }
  const maxSubqueries = maxPlannerTargetedBackfillSubqueries(params.family);
  if (maxSubqueries <= 0) {
    return {
      allowed: false,
      subqueries: [],
      maxSubqueries,
      exceededStage: "planner_targeted_backfill",
      decision: "planner_targeted_backfill_disabled_for_route_budget"
    };
  }
  const subqueries = params.subqueries.slice(0, maxSubqueries);
  return {
    allowed: true,
    subqueries,
    maxSubqueries,
    exceededStage: subqueries.length < params.subqueries.length ? "planner_targeted_backfill_subqueries" : undefined,
    decision: subqueries.length < params.subqueries.length
      ? `planner_targeted_backfill_limited_${params.subqueries.length}_to_${subqueries.length}`
      : undefined
  };
}

export function shouldSkipTypedLaneDescentForBudget(params: {
  readonly family: RetrievalLatencyBudget["family"];
  readonly shouldTrigger: boolean;
  readonly hasNextStage: boolean;
  readonly elapsedMs: number;
}): boolean {
  if (
    params.shouldTrigger &&
    params.hasNextStage &&
    (params.family === "default" ||
      params.family === "broad_direct_fact" ||
      params.family === "broad_preference_profile")
  ) {
    return true;
  }
  return (
    params.shouldTrigger &&
    params.hasNextStage &&
    params.elapsedMs > maxElapsedBeforeExpensiveStageMs(params.family, "typed_lane_descent")
  );
}
