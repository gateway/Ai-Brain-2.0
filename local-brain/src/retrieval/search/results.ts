import type { ArtifactId, RecallResult } from "../../types.js";
import type { RecallEvidenceItem, RecallResponse } from "../types.js";
import type { SearchRow } from "./internal-types.js";

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function buildRecallResult(
  row: SearchRow,
  score: number,
  retrieval: {
    readonly rrfScore: number;
    readonly lexicalRank?: number;
    readonly vectorRank?: number;
    readonly lexicalRawScore?: number;
    readonly vectorDistance?: number;
  }
): RecallResult {
  return {
    memoryId: row.memory_id,
    memoryType: row.memory_type,
    content: row.content,
    score,
    artifactId: row.artifact_id as ArtifactId | null,
    occurredAt: toIsoString(row.occurred_at),
    namespaceId: row.namespace_id,
    provenance: {
      ...row.provenance,
      retrieval
    }
  };
}

export function buildEvidenceBundle(results: readonly RecallResult[]): RecallResponse["evidence"] {
  const seen = new Set<string>();
  const evidence: Array<RecallEvidenceItem> = [];

  for (const result of results) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    if (!result.artifactId && !sourceUri) {
      continue;
    }
    const key = `${result.memoryId}|${result.artifactId ?? "none"}|${sourceUri ?? "none"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    evidence.push({
      memoryId: result.memoryId,
      memoryType: result.memoryType,
      artifactId: result.artifactId ?? null,
      occurredAt: result.occurredAt ?? null,
      sourceUri,
      snippet: result.content.slice(0, 320),
      provenance: result.provenance
    });
  }

  return evidence.slice(0, 12);
}

export function mergeRecallResults(
  primary: readonly RecallResult[],
  secondary: readonly RecallResult[],
  limit: number
): RecallResult[] {
  const merged: RecallResult[] = [];
  const seen = new Set<string>();

  for (const result of [...primary, ...secondary]) {
    if (seen.has(result.memoryId)) {
      continue;
    }
    seen.add(result.memoryId);
    merged.push(result);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}
