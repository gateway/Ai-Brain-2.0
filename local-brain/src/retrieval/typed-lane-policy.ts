import { inferTypedContract } from "./typed-contract-completeness.js";
import type { TypedContractName } from "./types.js";
import type { AnswerRetrievalPlan, RecallTypedLaneDescentStage } from "./types.js";

export type TypedLaneLexicalBranchName =
  | "relationship_candidate"
  | "memory_candidate"
  | "narrative_event"
  | "temporal_nodes"
  | "episodic_memory"
  | "artifact_derivation";

const DEFAULT_TYPED_LANE_DESCENT_ORDER: readonly RecallTypedLaneDescentStage[] = [
  "high_level_only",
  "relationship_candidate",
  "narrative_event",
  "episodic_memory",
  "artifact_derivation",
  "memory_candidate"
] as const;

const MULTIMODAL_TYPED_LANE_DESCENT_ORDER: readonly RecallTypedLaneDescentStage[] = [
  "high_level_only",
  "artifact_derivation",
  "episodic_memory",
  "relationship_candidate",
  "narrative_event",
  "memory_candidate"
] as const;

function shouldPrioritizeArtifactDerivations(contract: TypedContractName | null): boolean {
  switch (contract) {
    case "book_list":
    case "inventory_list":
    case "made_item_inventory":
    case "location_history":
    case "camping_location_history":
    case "event_inventory":
    case "identity_profile":
      return true;
    default:
      return false;
  }
}

function typedLaneStageOrderForPlan(
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): readonly RecallTypedLaneDescentStage[] {
  const contract = inferTypedContract(queryText, retrievalPlan);
  return shouldPrioritizeArtifactDerivations(contract)
    ? MULTIMODAL_TYPED_LANE_DESCENT_ORDER
    : DEFAULT_TYPED_LANE_DESCENT_ORDER;
}

export function typedLaneDisabledBranchesForPlan(
  stage: RecallTypedLaneDescentStage | null,
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): readonly TypedLaneLexicalBranchName[] {
  const order = typedLaneStageOrderForPlan(queryText, retrievalPlan);
  switch (stage) {
    case "high_level_only":
      return order.slice(1) as readonly TypedLaneLexicalBranchName[];
    case "artifact_derivation":
      return order.filter(
        (candidate) => candidate !== "high_level_only" && candidate !== "artifact_derivation"
      ) as readonly TypedLaneLexicalBranchName[];
    case "episodic_memory":
    case "relationship_candidate":
    case "narrative_event":
    case "memory_candidate": {
      const currentIndex = order.indexOf(stage);
      if (currentIndex < 0) {
        return [];
      }
      return order.slice(currentIndex + 1) as readonly TypedLaneLexicalBranchName[];
    }
    default:
      return [];
  }
}

export function nextTypedLaneDescentStageForPlan(
  stage: RecallTypedLaneDescentStage | null,
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): RecallTypedLaneDescentStage | null {
  if (!stage) {
    return null;
  }
  const order = typedLaneStageOrderForPlan(queryText, retrievalPlan);
  const currentIndex = order.indexOf(stage);
  if (currentIndex < 0 || currentIndex >= order.length - 1) {
    return null;
  }
  return order[currentIndex + 1] ?? null;
}

export function typedLaneDescentDepthForPlan(
  stage: RecallTypedLaneDescentStage | null,
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): number {
  if (!stage) {
    return -1;
  }
  return Math.max(0, typedLaneStageOrderForPlan(queryText, retrievalPlan).indexOf(stage));
}

export function remainingTypedLaneDescentBranchesForPlan(
  stage: RecallTypedLaneDescentStage | null,
  queryText: string,
  retrievalPlan: Pick<AnswerRetrievalPlan, "family" | "answerKind" | "lane" | "controllerIntent">
): readonly TypedLaneLexicalBranchName[] {
  if (!stage) {
    return [];
  }
  const order = typedLaneStageOrderForPlan(queryText, retrievalPlan);
  const currentIndex = order.indexOf(stage);
  if (currentIndex < 0) {
    return [];
  }
  const branches: TypedLaneLexicalBranchName[] = [];
  for (const candidate of order.slice(currentIndex + 1)) {
    if (candidate === "high_level_only") {
      continue;
    }
    branches.push(candidate as TypedLaneLexicalBranchName);
  }
  return branches;
}
