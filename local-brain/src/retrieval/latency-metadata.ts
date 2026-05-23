import { performance } from "node:perf_hooks";
import type { RecallResponse } from "./types.js";

function roundTimingMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildSingleStageLatencyMeta(params: {
  readonly stageName: string;
  readonly startedAt: number;
  readonly candidateCount?: number;
  readonly rowsScanned?: number;
  readonly earlyStopReason?: string;
  readonly relationshipFastPathTried?: boolean;
  readonly relationshipFastPathSucceeded?: boolean;
  readonly sourceBoundedReadTried?: boolean;
  readonly sourceBoundedReadSucceeded?: boolean;
  readonly compiledLookupTried?: boolean;
  readonly proceduralLookupTried?: boolean;
  readonly finalRouteFamily?: string;
}): Pick<
  RecallResponse["meta"],
  | "stageTimingsMs"
  | "dominantStage"
  | "topStageMs"
  | "candidateCountsByStage"
  | "rowsScannedByStage"
  | "earlyStopReason"
  | "relationshipFastPathTried"
  | "relationshipFastPathSucceeded"
  | "sourceBoundedReadTried"
  | "sourceBoundedReadSucceeded"
  | "compiledLookupTried"
  | "proceduralLookupTried"
  | "finalRouteFamily"
  | "semanticFallbackUsed"
  | "sqlHybridUsed"
  | "typedLaneDescentTriggered"
  | "plannerBackfillTriggered"
  | "graphExpansionTriggered"
> {
  const total = roundTimingMs(performance.now() - params.startedAt);
  return {
    stageTimingsMs: { [params.stageName]: total, total },
    dominantStage: params.stageName,
    topStageMs: total,
    candidateCountsByStage: typeof params.candidateCount === "number" ? { [params.stageName]: params.candidateCount } : undefined,
    rowsScannedByStage: typeof params.rowsScanned === "number" ? { [params.stageName]: params.rowsScanned } : undefined,
    earlyStopReason: params.earlyStopReason,
    relationshipFastPathTried: params.relationshipFastPathTried || undefined,
    relationshipFastPathSucceeded: params.relationshipFastPathSucceeded || undefined,
    sourceBoundedReadTried: params.sourceBoundedReadTried || undefined,
    sourceBoundedReadSucceeded: params.sourceBoundedReadSucceeded || undefined,
    compiledLookupTried: params.compiledLookupTried || undefined,
    proceduralLookupTried: params.proceduralLookupTried || undefined,
    finalRouteFamily: params.finalRouteFamily,
    semanticFallbackUsed: false,
    sqlHybridUsed: false,
    typedLaneDescentTriggered: false,
    plannerBackfillTriggered: false,
    graphExpansionTriggered: false
  };
}
