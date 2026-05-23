import { loadContractProjectionRuntime } from "../contract-projections/service.js";
import type { RecallQuery } from "./types.js";
import type { AnswerRetrievalPlan, RecallResponse } from "./types.js";
import type { RecallResult } from "../types.js";

function shouldReturnProjectionPreferred(params: {
  readonly contractName: string;
  readonly projectionKind: "list" | "report" | "temporal" | "scalar";
  readonly stopEligible: boolean;
  readonly complete: boolean;
  readonly completenessScore: number;
  readonly temporalFactCount: number;
  readonly activeSupportCount: number;
  readonly temporalExactness: "exact" | "bounded" | "inferred" | null;
}): boolean {
  if (params.stopEligible) {
    return true;
  }
  if (params.projectionKind === "scalar") {
    return params.activeSupportCount > 0 && (params.complete || params.completenessScore >= 0.85);
  }
  if (params.contractName === "temporal_event_bundle" || params.projectionKind === "temporal") {
    return (
      params.temporalFactCount > 0 &&
      params.activeSupportCount > 0 &&
      params.temporalExactness !== null
    );
  }
  if (params.projectionKind === "list") {
    return params.activeSupportCount > 0 && params.completenessScore >= 0.5;
  }
  if (params.projectionKind === "report") {
    return params.activeSupportCount > 0 && (params.complete || params.completenessScore >= 0.6);
  }
  return false;
}

export async function maybeLoadProjectionTypedLaneDecision(params: {
  readonly query: RecallQuery;
  readonly retrievalPlan: Pick<AnswerRetrievalPlan, "lane" | "controllerIntent" | "resolvedSubjectEntityId" | "subjectNames">;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly renderPayloadMode: "shadow" | "preferred" | "required";
  readonly sqlFusedKernelMode: "shadow" | "preferred" | "required";
}): Promise<{
  readonly results: readonly RecallResult[];
  readonly reason: string;
  readonly metaAugment: Partial<RecallResponse["meta"]>;
} | null> {
  if (params.renderPayloadMode === "shadow" && params.sqlFusedKernelMode === "shadow") {
    return null;
  }
  const projectionRuntime = await loadContractProjectionRuntime({
    namespaceId: params.query.namespaceId,
    queryText: params.query.query,
    retrievalPlan: params.retrievalPlan,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd
  });
  const shouldReturnProjection =
    projectionRuntime &&
    (
      params.renderPayloadMode === "required" ||
      params.sqlFusedKernelMode === "required" ||
      (
        (params.renderPayloadMode === "preferred" || params.sqlFusedKernelMode === "preferred") &&
        shouldReturnProjectionPreferred({
          contractName: projectionRuntime.contractName,
          projectionKind: projectionRuntime.projectionKind,
          stopEligible: projectionRuntime.stopEligible,
          complete: projectionRuntime.complete,
          completenessScore: projectionRuntime.completenessScore,
          temporalFactCount: projectionRuntime.temporalFactCount,
          activeSupportCount: projectionRuntime.activeSupportCount,
          temporalExactness: projectionRuntime.temporalExactness
        })
      )
    );
  if (!projectionRuntime || !shouldReturnProjection) {
    return null;
  }
  return {
    results: projectionRuntime.results,
    reason: projectionRuntime.reason,
    metaAugment: {
      projectionVersion: projectionRuntime.projectionVersion,
      temporalFactCount: projectionRuntime.temporalFactCount,
      fusedKernelMode: params.sqlFusedKernelMode,
      renderPayloadMode: params.renderPayloadMode,
      activeSupportCount: projectionRuntime.activeSupportCount,
      supersededSupportFilteredCount: projectionRuntime.supersededSupportFilteredCount,
      temporalExactness: projectionRuntime.temporalExactness,
      supportBundleFamily:
        projectionRuntime.projectionKind === "temporal"
          ? "temporal_detail"
          : projectionRuntime.projectionKind === "list"
            ? "typed_list_set"
            : projectionRuntime.projectionKind === "scalar"
              ? projectionRuntime.queryFamily === "current_state"
                ? "current_state"
                : "exact_detail"
              : "profile_report",
      authoritativeSource: projectionRuntime.authoritativeSource ?? undefined,
      temporalCoverageStatus:
        projectionRuntime.temporalExactness === "exact"
          ? "exact"
          : projectionRuntime.temporalExactness === "bounded"
            ? "bounded"
            : projectionRuntime.temporalExactness === "inferred"
              ? "partial"
              : projectionRuntime.projectionKind === "temporal"
                ? "unresolved"
                : undefined,
      structuredSufficiencyStatus:
        projectionRuntime.complete || projectionRuntime.stopEligible
          ? "sufficient"
          : projectionRuntime.activeSupportCount > 0
            ? "partial"
            : "insufficient",
      fallbackUsed: false,
      scalarTruthTried: projectionRuntime.projectionKind === "scalar" || undefined,
      eventTruthTried: projectionRuntime.projectionKind === "temporal" || undefined,
      backfillBlockedReason:
        projectionRuntime.complete || projectionRuntime.stopEligible
          ? "projection_truth_sufficient"
          : undefined
    }
  };
}
