import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd(), "..");
const runtimeBaseUrl = process.env.BRAIN_RUNTIME_BASE_URL ?? "http://127.0.0.1:8787";

interface EvalCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly details: string;
}

interface EvalReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly checks: readonly EvalCheck[];
  readonly metrics: Record<string, number>;
}

interface BenchmarkCase {
  readonly name: string;
  readonly provider: string;
  readonly passed: boolean;
  readonly resultCount: number;
  readonly effectiveLexicalProvider: string;
  readonly lexicalFallbackUsed: boolean;
  readonly topMemoryType?: string;
  readonly topContent?: string;
  readonly approxTokens?: number;
}

interface BenchmarkSummary {
  readonly ftsPassed: number;
  readonly bm25Passed: number;
  readonly totalCases: number;
  readonly bm25TokenDelta: number;
  readonly bm25FallbackCases: number;
  readonly recommendation: string;
  readonly reason: string;
}

interface BenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly baselineEvalPassed: boolean;
  readonly baselineEvalFailures: readonly string[];
  readonly cases: readonly BenchmarkCase[];
  readonly summary: BenchmarkSummary;
}

export interface ArtifactDetail {
  readonly artifactId: string;
  readonly namespaceId: string;
  readonly sourceType: string;
  readonly sourceUri: string;
  readonly latestObservationId?: string;
  readonly observations: readonly {
    readonly artifactObservationId: string;
    readonly observedAt: string;
    readonly contentHash: string;
    readonly byteSize: number;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly derivations: readonly {
    readonly artifactDerivationId: string;
    readonly derivationType: string;
    readonly contentText: string;
    readonly provider?: string;
    readonly model?: string;
    readonly createdAt: string;
  }[];
  readonly chunkCount: number;
  readonly episodicHits: readonly {
    readonly id: string;
    readonly content: string;
    readonly occurredAt?: string;
    readonly sourceUri?: string;
  }[];
}

export interface SearchResultItem {
  readonly id: string;
  readonly memoryType: string;
  readonly content: string;
  readonly occurredAt?: string;
  readonly sourceUri?: string;
  readonly score?: number;
  readonly lexicalProvider?: string;
  readonly lexicalFallbackUsed?: boolean;
}

export interface SearchResult {
  readonly planner?: {
    readonly intent?: string;
    readonly timeStart?: string;
    readonly timeEnd?: string;
    readonly branchPreference?: string;
    readonly lexicalTerms?: readonly string[];
    readonly temporalGateTriggered?: boolean;
  };
  readonly provider?: string;
  readonly lexicalProvider?: string;
  readonly lexicalFallbackUsed?: boolean;
  readonly results: readonly SearchResultItem[];
}

interface RuntimeRecallResult {
  readonly memoryId: string;
  readonly memoryType: string;
  readonly content: string;
  readonly occurredAt?: string;
  readonly score?: number;
  readonly provenance?: Record<string, unknown>;
}

interface RuntimeSearchResponse {
  readonly results: readonly RuntimeRecallResult[];
  readonly meta: {
    readonly lexicalProvider: "fts" | "bm25";
    readonly lexicalFallbackUsed: boolean;
    readonly queryEmbeddingProvider?: string;
    readonly planner?: {
      readonly intent?: string;
      readonly inferredTimeStart?: string;
      readonly inferredTimeEnd?: string;
      readonly branchPreference?: string;
      readonly lexicalTerms?: readonly string[];
    };
    readonly temporalGateTriggered?: boolean;
  };
}

export interface OpsOverview {
  readonly lexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackEnabled: boolean;
  readonly queueSummary: {
    readonly derivation: {
      readonly pending: number;
      readonly processing: number;
      readonly failed: number;
      readonly completed: number;
      readonly nextAttemptAt?: string;
    };
    readonly vectorSync: {
      readonly pending: number;
      readonly processing: number;
      readonly failed: number;
      readonly completed: number;
      readonly nextAttemptAt?: string;
    };
  };
  readonly memorySummary: {
    readonly temporalNodes: number;
    readonly relationshipCandidatesPending: number;
    readonly relationshipMemoryActive: number;
    readonly semanticDecayEvents: number;
    readonly clarificationPending: number;
    readonly outboxPending: number;
  };
}

export interface OpsTimelineItem {
  readonly memoryId: string;
  readonly content: string;
  readonly occurredAt: string;
  readonly artifactId?: string | null;
  readonly sourceUri?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsTemporalSummary {
  readonly temporalNodeId: string;
  readonly layer: "session" | "day" | "week" | "month" | "year" | "profile";
  readonly summaryText: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sourceCount: number;
  readonly depth?: number | null;
  readonly parentId?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsTimelineView {
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly timeline: readonly OpsTimelineItem[];
  readonly summaries: readonly OpsTemporalSummary[];
}

export interface OpsRelationshipGraphNode {
  readonly id: string;
  readonly name: string;
  readonly entityType: string;
  readonly degree: number;
  readonly mentionCount: number;
  readonly isSelected: boolean;
}

export interface OpsRelationshipGraphEdge {
  readonly id: string;
  readonly subjectId: string;
  readonly objectId: string;
  readonly subjectName: string;
  readonly objectName: string;
  readonly predicate: string;
  readonly confidence: number;
  readonly validFrom: string;
  readonly sourceCandidateId?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface OpsRelationshipGraph {
  readonly namespaceId: string;
  readonly selectedEntity?: string;
  readonly nodes: readonly OpsRelationshipGraphNode[];
  readonly edges: readonly OpsRelationshipGraphEdge[];
}

export interface OpsClarificationInboxItem {
  readonly candidateId: string;
  readonly claimType: string;
  readonly predicate: string;
  readonly targetRole: "subject" | "object";
  readonly rawText: string;
  readonly confidence: number;
  readonly priorScore: number;
  readonly ambiguityType: string;
  readonly ambiguityReason?: string | null;
  readonly suggestedMatches: readonly string[];
  readonly occurredAt: string;
  readonly sceneText?: string | null;
  readonly sourceUri?: string | null;
}

export interface OpsClarificationInbox {
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly items: readonly OpsClarificationInboxItem[];
}

async function readJsonFile<T>(segments: readonly string[]): Promise<T> {
  const filePath = path.join(repoRoot, ...segments);
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readMarkdownFile(segments: readonly string[]): Promise<string> {
  const filePath = path.join(repoRoot, ...segments);
  return fs.readFile(filePath, "utf8");
}

async function fetchJson<T>(pathname: string, searchParams?: URLSearchParams): Promise<T> {
  const url = new URL(pathname, runtimeBaseUrl);

  if (searchParams) {
    url.search = searchParams.toString();
  }

  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function getHealth(): Promise<{ readonly ok: boolean }> {
  return fetchJson<{ readonly ok: boolean }>("/health");
}

export async function getOpsOverview(): Promise<OpsOverview> {
  return fetchJson<OpsOverview>("/ops/overview");
}

export async function getLatestEval(): Promise<{ readonly json: EvalReport; readonly markdown: string }> {
  const [json, markdown] = await Promise.all([
    readJsonFile<EvalReport>(["local-brain", "eval-results", "latest.json"]),
    readMarkdownFile(["local-brain", "eval-results", "latest.md"])
  ]);

  return { json, markdown };
}

export async function getLatestBenchmark(): Promise<{ readonly json: BenchmarkReport; readonly markdown: string }> {
  const [json, markdown] = await Promise.all([
    readJsonFile<BenchmarkReport>(["local-brain", "benchmark-results", "latest.json"]),
    readMarkdownFile(["local-brain", "benchmark-results", "latest.md"])
  ]);

  return { json, markdown };
}

export async function getConsoleDefaults(): Promise<{
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
}> {
  try {
    const { json } = await getLatestEval();
    return {
      namespaceId: json.namespaceId,
      timeStart: "2026-01-01T00:00:00Z",
      timeEnd: "2026-12-31T23:59:59Z"
    };
  } catch {
    return {
      namespaceId: "personal",
      timeStart: "2026-01-01T00:00:00Z",
      timeEnd: "2026-12-31T23:59:59Z"
    };
  }
}

export async function searchBrain(input: {
  readonly namespaceId: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly dimensions?: string;
  readonly limit?: string;
}): Promise<SearchResult> {
  const params = new URLSearchParams({
    namespace_id: input.namespaceId,
    query: input.query
  });

  if (input.timeStart) {
    params.set("time_start", input.timeStart);
  }
  if (input.timeEnd) {
    params.set("time_end", input.timeEnd);
  }
  if (input.provider) {
    params.set("provider", input.provider);
  }
  if (input.model) {
    params.set("model", input.model);
  }
  if (input.dimensions) {
    params.set("dimensions", input.dimensions);
  }
  if (input.limit) {
    params.set("limit", input.limit);
  }

  const response = await fetchJson<RuntimeSearchResponse>("/search", params);

  return {
    provider: response.meta.queryEmbeddingProvider,
    lexicalProvider: response.meta.lexicalProvider,
    lexicalFallbackUsed: response.meta.lexicalFallbackUsed,
    planner: {
      intent: response.meta.planner?.intent,
      timeStart: response.meta.planner?.inferredTimeStart,
      timeEnd: response.meta.planner?.inferredTimeEnd,
      branchPreference: response.meta.planner?.branchPreference,
      lexicalTerms: response.meta.planner?.lexicalTerms,
      temporalGateTriggered: response.meta.temporalGateTriggered
    },
    results: response.results.map((item) => ({
      id: item.memoryId,
      memoryType: item.memoryType,
      content: item.content,
      occurredAt: item.occurredAt,
      score: item.score,
      sourceUri: typeof item.provenance?.source_uri === "string" ? item.provenance.source_uri : undefined,
      lexicalProvider: response.meta.lexicalProvider,
      lexicalFallbackUsed: response.meta.lexicalFallbackUsed
    }))
  };
}

export async function getArtifactDetail(artifactId: string): Promise<ArtifactDetail> {
  return fetchJson<ArtifactDetail>(`/artifacts/${artifactId}`);
}

export async function getTimelineView(input: {
  readonly namespaceId: string;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly limit?: string;
}): Promise<OpsTimelineView> {
  const params = new URLSearchParams({
    namespace_id: input.namespaceId,
    time_start: input.timeStart,
    time_end: input.timeEnd
  });

  if (input.limit) {
    params.set("limit", input.limit);
  }

  return fetchJson<OpsTimelineView>("/ops/timeline", params);
}

export async function getRelationshipGraph(input: {
  readonly namespaceId: string;
  readonly entityName?: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: string;
}): Promise<OpsRelationshipGraph> {
  const params = new URLSearchParams({
    namespace_id: input.namespaceId
  });

  if (input.entityName) {
    params.set("entity_name", input.entityName);
  }
  if (input.timeStart) {
    params.set("time_start", input.timeStart);
  }
  if (input.timeEnd) {
    params.set("time_end", input.timeEnd);
  }
  if (input.limit) {
    params.set("limit", input.limit);
  }

  return fetchJson<OpsRelationshipGraph>("/ops/graph", params);
}

export async function getClarificationInbox(input: {
  readonly namespaceId: string;
  readonly limit?: string;
}): Promise<OpsClarificationInbox> {
  const params = new URLSearchParams({
    namespace_id: input.namespaceId
  });

  if (input.limit) {
    params.set("limit", input.limit);
  }

  return fetchJson<OpsClarificationInbox>("/ops/inbox", params);
}

export function getRuntimeBaseUrl(): string {
  return runtimeBaseUrl;
}
