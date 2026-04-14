import { AsyncLocalStorage } from "node:async_hooks";
import { lookupStoredCanonicalForQuery, type StoredCanonicalLookup } from "../../canonical-memory/service.js";
import { lookupStoredNarrativeForQuery } from "../../canonical-memory/narrative-reader.js";
import type { RecallResult } from "../../types.js";
import type { ExactDetailQuestionFamily } from "../exact-detail-question-family.js";
import type { SearchRow } from "./internal-types.js";

export interface RuntimeRequestContext {
  readonly key: string;
  readonly primarySourceBackfillCache: Map<string, readonly string[]>;
  readonly fullSourceBackfillCache: Map<string, readonly string[]>;
  readonly linkedSourceExpansionCache: Map<string, readonly RecallResult[]>;
  readonly boundedEventSceneSupportCache: Map<string, Promise<SearchRow[]>>;
  readonly boundedEventNeighborhoodSupportCache: Map<string, Promise<SearchRow[]>>;
  readonly eventNeighborhoodEpisodicCache: Map<string, Promise<SearchRow[]>>;
  readonly storedCanonicalLookupCache: Map<string, Promise<StoredCanonicalLookup | null>>;
  readonly storedNarrativeLookupCache: Map<string, Promise<Awaited<ReturnType<typeof lookupStoredNarrativeForQuery>>>>;
}

const runtimeRequestStorage = new AsyncLocalStorage<RuntimeRequestContext>();

function normalizeContextWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function createRuntimeRequestContext(key: string): RuntimeRequestContext {
  return {
    key,
    primarySourceBackfillCache: new Map(),
    fullSourceBackfillCache: new Map(),
    linkedSourceExpansionCache: new Map(),
    boundedEventSceneSupportCache: new Map(),
    boundedEventNeighborhoodSupportCache: new Map(),
    eventNeighborhoodEpisodicCache: new Map(),
    storedCanonicalLookupCache: new Map(),
    storedNarrativeLookupCache: new Map()
  };
}

export function currentRuntimeRequestContext(): RuntimeRequestContext | null {
  return runtimeRequestStorage.getStore() ?? null;
}

export function runWithRuntimeRequestContext<T>(key: string, work: () => T): T {
  return runtimeRequestStorage.run(createRuntimeRequestContext(key), work);
}

export function stableRecallResultCacheKey(results: readonly RecallResult[]): string {
  return results
    .map((result) => result.memoryId || `${result.memoryType}:${result.artifactId ?? ""}:${result.occurredAt ?? ""}:${result.content}`)
    .join("|");
}

export function stableTextListCacheKey(values: readonly string[]): string {
  return values
    .map((value) => normalizeContextWhitespace(value).toLowerCase())
    .filter((value) => value.length > 0)
    .sort()
    .join("|");
}

export function memoizeRuntimeRequestValue<T>(cache: Map<string, T>, key: string, loader: () => T): T {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const value = loader();
  cache.set(key, value);
  return value;
}

export function memoizeRuntimeRequestPromise<T>(cache: Map<string, Promise<T>>, key: string, loader: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const pending = loader();
  cache.set(key, pending);
  return pending;
}

export async function lookupStoredCanonicalForQueryCached(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly exactDetailFamily: ExactDetailQuestionFamily;
  readonly matchedParticipants: readonly string[];
  readonly missingParticipants: readonly string[];
  readonly foreignParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<StoredCanonicalLookup | null> {
  const runtimeContext = currentRuntimeRequestContext();
  if (!runtimeContext) {
    return lookupStoredCanonicalForQuery(params);
  }
  const cacheKey = [
    params.namespaceId,
    normalizeContextWhitespace(params.queryText).toLowerCase(),
    params.exactDetailFamily,
    stableTextListCacheKey(params.matchedParticipants),
    stableTextListCacheKey(params.missingParticipants),
    stableTextListCacheKey(params.foreignParticipants),
    stableRecallResultCacheKey(params.results)
  ].join("::");
  return memoizeRuntimeRequestPromise(runtimeContext.storedCanonicalLookupCache, cacheKey, () => lookupStoredCanonicalForQuery(params));
}

export async function lookupStoredNarrativeForQueryCached(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly exactDetailFamily: ExactDetailQuestionFamily;
  readonly matchedParticipants: readonly string[];
  readonly results: readonly RecallResult[];
}): Promise<Awaited<ReturnType<typeof lookupStoredNarrativeForQuery>>> {
  const runtimeContext = currentRuntimeRequestContext();
  if (!runtimeContext) {
    return lookupStoredNarrativeForQuery(params);
  }
  const cacheKey = [
    params.namespaceId,
    normalizeContextWhitespace(params.queryText).toLowerCase(),
    params.exactDetailFamily,
    stableTextListCacheKey(params.matchedParticipants),
    stableRecallResultCacheKey(params.results)
  ].join("::");
  return memoizeRuntimeRequestPromise(runtimeContext.storedNarrativeLookupCache, cacheKey, () => lookupStoredNarrativeForQuery(params));
}
