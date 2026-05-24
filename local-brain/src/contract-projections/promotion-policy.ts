import { createHash } from "node:crypto";
import type { ContractProjectionKind, ContractProjectionName, ProjectionTruthStatus } from "./service.js";

export type ProjectionConflictStatus = "none" | "role_conflict" | "owner_conflict" | "source_conflict" | "needs_review";
export type ProjectionCorrectionOverlayStatus = "none" | "applied" | "pending" | "blocked";

export interface ProjectionPromotionPolicy {
  readonly id: string;
  readonly contractName: ContractProjectionName | "default";
  readonly projectionKind: ContractProjectionKind | "any";
  readonly minCompletenessScore: number;
  readonly minSupportCount: number;
  readonly allowUncertainTruth: boolean;
  readonly requiresAllRequiredFields: boolean;
}

export interface ProjectionPromotionInput {
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly completenessScore: number;
  readonly supportCount: number;
  readonly requiredFields: readonly string[];
  readonly fulfilledFields: readonly string[];
  readonly truthStatus: ProjectionTruthStatus;
  readonly conflictStatus?: ProjectionConflictStatus;
  readonly correctionOverlayStatus?: ProjectionCorrectionOverlayStatus;
}

export interface ProjectionPromotionDecision {
  readonly policyId: string;
  readonly stopEligible: boolean;
  readonly conflictStatus: ProjectionConflictStatus;
  readonly correctionOverlayStatus: ProjectionCorrectionOverlayStatus;
  readonly reasons: readonly string[];
}

export const PROJECTION_PROMOTION_POLICIES: readonly ProjectionPromotionPolicy[] = [
  {
    id: "relationship_map_source_bound_v1",
    contractName: "relationship_map",
    projectionKind: "report",
    minCompletenessScore: 0.85,
    minSupportCount: 1,
    allowUncertainTruth: false,
    requiresAllRequiredFields: true
  },
  {
    id: "relationship_chronology_source_bound_v1",
    contractName: "relationship_chronology",
    projectionKind: "report",
    minCompletenessScore: 0.85,
    minSupportCount: 1,
    allowUncertainTruth: false,
    requiresAllRequiredFields: true
  },
  {
    id: "temporal_event_bundle_source_bound_v1",
    contractName: "temporal_event_bundle",
    projectionKind: "temporal",
    minCompletenessScore: 0.8,
    minSupportCount: 1,
    allowUncertainTruth: true,
    requiresAllRequiredFields: true
  },
  {
    id: "default_source_bound_projection_v1",
    contractName: "default",
    projectionKind: "any",
    minCompletenessScore: 0.85,
    minSupportCount: 1,
    allowUncertainTruth: false,
    requiresAllRequiredFields: true
  }
];

export function projectionPromotionPolicyFor(
  contractName: ContractProjectionName,
  projectionKind: ContractProjectionKind
): ProjectionPromotionPolicy {
  return (
    PROJECTION_PROMOTION_POLICIES.find((policy) => policy.contractName === contractName && policy.projectionKind === projectionKind) ??
    PROJECTION_PROMOTION_POLICIES.find((policy) => policy.contractName === contractName && policy.projectionKind === "any") ??
    PROJECTION_PROMOTION_POLICIES.find((policy) => policy.contractName === "default")!
  );
}

export function evaluateProjectionPromotion(input: ProjectionPromotionInput): ProjectionPromotionDecision {
  const policy = projectionPromotionPolicyFor(input.contractName, input.projectionKind);
  const conflictStatus = input.conflictStatus ?? "none";
  const correctionOverlayStatus = input.correctionOverlayStatus ?? "none";
  const allFieldsFulfilled =
    input.requiredFields.length === 0 || input.requiredFields.every((field) => input.fulfilledFields.includes(field));
  const reasons: string[] = [];
  if (input.truthStatus === "superseded") reasons.push("truth_status_superseded");
  if (input.truthStatus === "uncertain" && !policy.allowUncertainTruth) reasons.push("truth_status_uncertain");
  if (input.completenessScore < policy.minCompletenessScore) reasons.push("completeness_below_policy");
  if (input.supportCount < policy.minSupportCount) reasons.push("support_count_below_policy");
  if (policy.requiresAllRequiredFields && !allFieldsFulfilled) reasons.push("required_fields_missing");
  if (conflictStatus !== "none") reasons.push(`conflict_${conflictStatus}`);
  if (correctionOverlayStatus === "pending" || correctionOverlayStatus === "blocked") reasons.push(`correction_overlay_${correctionOverlayStatus}`);
  return {
    policyId: policy.id,
    stopEligible: reasons.length === 0,
    conflictStatus,
    correctionOverlayStatus,
    reasons
  };
}

export function projectionReplaySignature(input: {
  readonly contractName: ContractProjectionName;
  readonly projectionKind: ContractProjectionKind;
  readonly bundleKey: string;
  readonly truthStatus: ProjectionTruthStatus;
  readonly completenessScore: number;
  readonly supportCount: number;
  readonly entryCount: number;
  readonly summaryText: string | null;
  readonly projectionVersion: string;
  readonly requiredFields: readonly string[];
  readonly fulfilledFields: readonly string[];
  readonly conflictStatus?: ProjectionConflictStatus;
  readonly correctionOverlayStatus?: ProjectionCorrectionOverlayStatus;
}): string {
  const stable = {
    contractName: input.contractName,
    projectionKind: input.projectionKind,
    bundleKey: input.bundleKey,
    truthStatus: input.truthStatus,
    completenessScore: Number(input.completenessScore.toFixed(4)),
    supportCount: input.supportCount,
    entryCount: input.entryCount,
    summaryText: input.summaryText ?? "",
    projectionVersion: input.projectionVersion,
    requiredFields: [...input.requiredFields].sort(),
    fulfilledFields: [...input.fulfilledFields].sort(),
    conflictStatus: input.conflictStatus ?? "none",
    correctionOverlayStatus: input.correctionOverlayStatus ?? "none"
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
