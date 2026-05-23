import type { RecallResult } from "../types.js";
import type { SearchRow } from "./search/internal-types.js";
import {
  isDailyLifeSummaryQuery,
  isDepartureTimingQuery,
  isMediaSummaryQuery,
  isRoutineSummaryQuery,
  isWarmStartQuery
} from "./query-signals.js";

function isCurrentProjectQueryText(queryText: string): boolean {
  return (
    /\bwhat project am i actively focused on right now\b/i.test(queryText) ||
    /\bcurrent projects?\b/i.test(queryText) ||
    /\bprojects?\s+am\s+i\s+(?:working on|focused on)\b/i.test(queryText)
  );
}

function rowSourceUri(row: Pick<SearchRow, "provenance">): string | null {
  return typeof row.provenance.source_uri === "string" && row.provenance.source_uri.length > 0
    ? row.provenance.source_uri
    : null;
}

function recallResultSourceUri(result: Pick<RecallResult, "provenance">): string | null {
  return typeof result.provenance.source_uri === "string" && result.provenance.source_uri.length > 0
    ? result.provenance.source_uri
    : null;
}

export function isPersonalSemanticNamespace(namespaceId: string): boolean {
  return namespaceId === "personal" || namespaceId.startsWith("personal_");
}

function isPersonalContinuityNamespace(namespaceId: string): boolean {
  return namespaceId === "personal_continuity_shadow" || namespaceId.startsWith("personal_continuity_shadow_");
}

export function isPersonalContaminantSourceUri(sourceUri: string | null): boolean {
  if (!sourceUri) {
    return false;
  }

  return (
    sourceUri.includes("/benchmark-generated/") ||
    sourceUri.includes("/examples-private/life-replay/") ||
    sourceUri.includes("/local-brain/examples/")
  );
}

export function isTrustedPersonalSourceUri(sourceUri: string | null): boolean {
  if (!sourceUri) {
    return false;
  }

  return (
    sourceUri.includes("/omi-archive/normalized/") ||
    sourceUri.includes("/data/inbox/omi/normalized/") ||
    sourceUri.includes("/omi-watch-smoke/") ||
    sourceUri.includes("/personal-openclaw-fixtures/")
  );
}

export function sourceTrustAdjustment(row: Pick<SearchRow, "namespace_id" | "provenance">): number {
  const sourceUri = rowSourceUri(row);
  if (isPersonalSemanticNamespace(row.namespace_id) && !isPersonalContinuityNamespace(row.namespace_id)) {
    if (isPersonalContaminantSourceUri(sourceUri)) {
      return -3.25;
    }
    if (isTrustedPersonalSourceUri(sourceUri)) {
      return 0.85;
    }
  }

  if (isPersonalContinuityNamespace(row.namespace_id) && isTrustedPersonalSourceUri(sourceUri)) {
    return 0.65;
  }

  return 0;
}

export function retainTrustedNamespaceRows<T extends { readonly row: SearchRow }>(rows: readonly T[]): T[] {
  if (rows.length === 0) {
    return [];
  }

  const hasTrustedPersonalRows = rows.some(
    (item) =>
      isPersonalSemanticNamespace(item.row.namespace_id) &&
      !isPersonalContinuityNamespace(item.row.namespace_id) &&
      isTrustedPersonalSourceUri(rowSourceUri(item.row))
  );
  if (!hasTrustedPersonalRows) {
    return [...rows];
  }

  const filtered = rows.filter(
    (item) =>
      !(
        isPersonalSemanticNamespace(item.row.namespace_id) &&
        !isPersonalContinuityNamespace(item.row.namespace_id) &&
        isPersonalContaminantSourceUri(rowSourceUri(item.row))
      )
  );
  return filtered.length > 0 ? filtered : [...rows];
}

function shouldRequireTrustedPersonalProductResults(namespaceId: string, queryText: string): boolean {
  if (!isPersonalSemanticNamespace(namespaceId)) {
    return false;
  }

  return (
    isDailyLifeSummaryQuery(queryText) ||
    isCurrentProjectQueryText(queryText) ||
    /\bpick back up\b/i.test(queryText) ||
    isWarmStartQuery(queryText) ||
    isRoutineSummaryQuery(queryText) ||
    /\bhabits?\b|\bconstraints?\b/i.test(queryText) ||
    isMediaSummaryQuery(queryText) ||
    /\bproject idea\b/i.test(queryText) ||
    /\bwho is .+ in my life\b/i.test(queryText) ||
    /\bwhat changed\b/i.test(queryText) ||
    /\bimportant relationship transition\b/i.test(queryText) ||
    isDepartureTimingQuery(queryText)
  );
}

export function retainTrustedPersonalRecallResults(
  results: readonly RecallResult[],
  namespaceId: string,
  queryText: string
): RecallResult[] {
  if (!shouldRequireTrustedPersonalProductResults(namespaceId, queryText) || results.length === 0) {
    return [...results];
  }

  const trusted = results.filter((result) => {
    const sourceUri = recallResultSourceUri(result);
    if (isTrustedPersonalSourceUri(sourceUri)) {
      return true;
    }
    return (
      !sourceUri &&
      (result.memoryType === "procedural_memory" ||
        result.memoryType === "semantic_memory" ||
        result.memoryType === "relationship_memory" ||
        result.memoryType === "temporal_nodes")
    );
  });

  if (trusted.length === 0) {
    return [...results];
  }

  const filtered = trusted.filter((result) => !isPersonalContaminantSourceUri(recallResultSourceUri(result)));
  return filtered.length > 0 ? filtered : trusted;
}
