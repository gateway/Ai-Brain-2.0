import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RecallResult } from "../types.js";

interface SourceNeighborhoodDeps {
  readonly normalizeWhitespace: (value: string) => string;
  readonly extractPrimaryEntityBoundTextFromContent: (queryText: string, content: string) => string;
}

export function gatherPrimaryEntitySourceBackfillTexts(
  queryText: string,
  results: readonly RecallResult[],
  deps: SourceNeighborhoodDeps
): readonly string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )].map((sourceUri) => deps.extractPrimaryEntityBoundTextFromContent(queryText, readFileSync(sourceUri, "utf8")));
}

export function gatherFullSourceBackfillTexts(results: readonly RecallResult[]): readonly string[] {
  return [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )].map((sourceUri) => readFileSync(sourceUri, "utf8"));
}

export function extendResultsWithLinkedSourceRows(
  seedResults: readonly RecallResult[],
  allResults: readonly RecallResult[]
): readonly RecallResult[] {
  if (seedResults.length === 0 || allResults.length === 0) {
    return seedResults;
  }

  const artifactIds = new Set(
    seedResults
      .map((result) => result.artifactId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const artifactObservationIds = new Set(
    seedResults
      .map((result) =>
        typeof result.provenance.artifact_observation_id === "string" ? result.provenance.artifact_observation_id : null
      )
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const sourceChunkIds = new Set(
    seedResults
      .map((result) => (typeof result.provenance.source_chunk_id === "string" ? result.provenance.source_chunk_id : null))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const sourceMemoryIds = new Set(
    seedResults
      .map((result) => (typeof result.provenance.source_memory_id === "string" ? result.provenance.source_memory_id : null))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  const deduped: RecallResult[] = [];
  const seen = new Set<string>();
  for (const result of [...seedResults, ...allResults]) {
    const sourceUri = typeof result.provenance.source_uri === "string" ? result.provenance.source_uri : null;
    const hasReadableSourceUri = typeof sourceUri === "string" && sourceUri.startsWith("/") && existsSync(sourceUri);
    const sharesArtifact = typeof result.artifactId === "string" && artifactIds.has(result.artifactId);
    const observationId =
      typeof result.provenance.artifact_observation_id === "string" ? result.provenance.artifact_observation_id : null;
    const sharesObservation = typeof observationId === "string" && artifactObservationIds.has(observationId);
    const sourceChunkId = typeof result.provenance.source_chunk_id === "string" ? result.provenance.source_chunk_id : null;
    const sharesChunk = typeof sourceChunkId === "string" && sourceChunkIds.has(sourceChunkId);
    const sourceMemoryId =
      typeof result.provenance.source_memory_id === "string" ? result.provenance.source_memory_id : null;
    const sharesSourceMemory = typeof sourceMemoryId === "string" && sourceMemoryIds.has(sourceMemoryId);
    const keep =
      seedResults.includes(result) ||
      (hasReadableSourceUri && (sharesArtifact || sharesObservation || sharesChunk || sharesSourceMemory));
    if (!keep) {
      continue;
    }
    const key = `${result.memoryId}\u0000${result.artifactId ?? ""}\u0000${result.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

export function expandConversationSessionSourceUris(results: readonly RecallResult[]): readonly string[] {
  const directSourceUris = [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/") && existsSync(value))
  )];
  if (directSourceUris.length === 0) {
    return [];
  }

  return [...new Set(
    directSourceUris.flatMap((sourceUri) => {
      const sessionMatch = basename(sourceUri).match(/^(.*-session_)\d+\.md$/u);
      if (!sessionMatch) {
        return [sourceUri];
      }
      try {
        return readdirSync(dirname(sourceUri))
          .filter((entry) => entry.startsWith(sessionMatch[1]!) && entry.endsWith(".md"))
          .map((entry) => join(dirname(sourceUri), entry));
      } catch {
        return [sourceUri];
      }
    })
  )];
}

export function collectConversationSiblingSourceTexts(
  queryText: string,
  results: readonly RecallResult[],
  options: {
    readonly primaryBound?: boolean;
  } | undefined,
  deps: SourceNeighborhoodDeps
): readonly string[] {
  const primaryBound = options?.primaryBound ?? false;
  return expandConversationSessionSourceUris(results)
    .map((sourceUri) => {
      const content = readFileSync(sourceUri, "utf8");
      return primaryBound ? deps.extractPrimaryEntityBoundTextFromContent(queryText, content) : content;
    })
    .map((value) => deps.normalizeWhitespace(value))
    .filter(Boolean);
}
