import type { CanonicalAbstainReason, CanonicalPredicateFamily, CanonicalTimeScopeKind, ReasoningChain } from "./types.js";
import type { RecallResult } from "../types.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter((value) => value.length > 0))];
}

function readStringProvenance(result: RecallResult, key: string): string | null {
  const direct = result.provenance[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const metadata =
    typeof result.provenance.metadata === "object" && result.provenance.metadata !== null
      ? (result.provenance.metadata as Record<string, unknown>)
      : null;
  const nested = metadata?.[key];
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

export function buildReasoningChain(params: {
  readonly queryText: string;
  readonly predicateFamily: CanonicalPredicateFamily;
  readonly timeScopeKind: CanonicalTimeScopeKind;
  readonly topClaim: string;
  readonly subjectNames: readonly string[];
  readonly pairSubjectNames?: readonly string[];
  readonly results: readonly RecallResult[];
  readonly canonicalSupport: readonly string[];
  readonly abstainReason?: CanonicalAbstainReason | null;
  readonly exclusionClauses?: readonly string[];
}): ReasoningChain {
  const provenanceIds = uniqueStrings(
    params.results
      .flatMap((result) => [
        result.memoryId,
        readStringProvenance(result, "source_memory_id") ?? "",
        readStringProvenance(result, "source_event_id") ?? "",
        readStringProvenance(result, "source_chunk_id") ?? ""
      ])
  );

  return {
    subjectChain: uniqueStrings([...params.subjectNames, ...(params.pairSubjectNames ?? [])]),
    predicateChain: uniqueStrings([params.predicateFamily, params.queryText]),
    temporalChain: uniqueStrings([params.timeScopeKind, params.topClaim]),
    canonicalSupport: uniqueStrings(params.canonicalSupport),
    provenanceIds,
    abstentionBlockers: params.abstainReason ? [params.abstainReason] : [],
    exclusionClauses: uniqueStrings(params.exclusionClauses ?? [])
  };
}
