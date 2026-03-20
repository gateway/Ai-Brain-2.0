const runtimeBaseUrl = process.env.BRAIN_RUNTIME_BASE_URL ?? "http://127.0.0.1:8787";
const openRouterBaseUrl = process.env.BRAIN_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

export type WorkbenchModelProvider = "external" | "openrouter" | "gemini";
export type WorkbenchEmbeddingProvider = "none" | WorkbenchModelProvider;
export type BrainPurposeMode = "personal" | "business" | "creative" | "hybrid";

interface JsonEnvelope<T> {
  readonly session?: T;
  readonly sessions?: readonly T[];
  readonly review?: T;
  readonly timeline?: T;
  readonly bootstrap?: T;
  readonly source?: T;
  readonly sources?: readonly T[];
  readonly preview?: T;
  readonly files?: readonly T[];
}

export interface NamespaceChoice {
  readonly namespaceId: string;
  readonly activityAt: string;
  readonly category: "durable" | "system";
  readonly artifactCount: number;
  readonly relationshipCount: number;
  readonly hasSelfProfile: boolean;
}

interface RuntimeNamespaceCatalog {
  readonly defaultNamespaceId?: string;
  readonly namespaces: readonly NamespaceChoice[];
}

export interface WorkbenchSession {
  readonly id: string;
  readonly namespaceId: string;
  readonly title: string;
  readonly notes?: string;
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly defaultAsrModel?: string;
  readonly defaultLlmProvider?: WorkbenchModelProvider;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly defaultEmbeddingProvider?: WorkbenchModelProvider;
  readonly defaultEmbeddingModel?: string;
  readonly metadata: Record<string, unknown>;
  readonly counts?: {
    readonly inputs: number;
    readonly artifacts: number;
    readonly modelRuns: number;
    readonly openClarifications: number;
  };
  readonly recentInputs?: readonly WorkbenchSessionInput[];
  readonly artifacts?: readonly WorkbenchSessionArtifact[];
  readonly recentRuns?: readonly WorkbenchSessionModelRun[];
}

export interface WorkbenchSessionInput {
  readonly id: string;
  readonly inputType: string;
  readonly label?: string;
  readonly rawText?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly durationSeconds?: number;
  readonly artifactId?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchSessionArtifact {
  readonly artifactId: string;
  readonly role: string;
  readonly status: string;
  readonly deriveStatus?: string;
  readonly classifyStatus?: string;
  readonly createdAt: string;
  readonly sourceType: string;
  readonly uri: string;
  readonly mimeType?: string;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchSessionModelRun {
  readonly id: string;
  readonly family: string;
  readonly endpoint: string;
  readonly providerId?: WorkbenchModelProvider;
  readonly model: string;
  readonly presetId?: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly errorText?: string;
  readonly metrics: Record<string, unknown>;
}

export interface SessionReview {
  readonly session: WorkbenchSession;
  readonly sources: readonly WorkbenchSessionInput[];
  readonly entities: readonly {
    readonly entityId: string;
    readonly displayLabel: string;
    readonly entityType: string;
    readonly evidenceCount: number;
    readonly confidence?: number;
    readonly aliases: readonly string[];
  }[];
  readonly relationships: readonly {
    readonly relationshipId: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object: string;
    readonly confidence?: number;
    readonly status: string;
    readonly evidenceCount: number;
    readonly sourceRef?: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly normalizedText: string;
    readonly claimType: string;
    readonly confidence?: number;
    readonly status: string;
    readonly ambiguityState: string;
    readonly ambiguityType?: string;
    readonly ambiguityReason?: string;
    readonly sourceRef?: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly unresolvedItems: readonly {
    readonly claimId: string;
    readonly title: string;
    readonly description: string;
    readonly ambiguityType?: string;
    readonly confidence?: number;
    readonly sourceRef?: string;
    readonly suggestions: readonly string[];
  }[];
  readonly summary: {
    readonly entityCount: number;
    readonly relationshipCount: number;
    readonly claimCount: number;
    readonly unresolvedCount: number;
  };
}

export interface WorkbenchSessionTimelineItem {
  readonly memoryId: string;
  readonly content: string;
  readonly occurredAt: string;
  readonly artifactId?: string | null;
  readonly sourceUri?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchSessionTemporalSummary {
  readonly temporalNodeId: string;
  readonly layer: "session" | "day" | "week" | "month" | "year" | "profile";
  readonly summaryText: string;
  readonly generatedBy: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly sourceCount: number;
  readonly depth?: number | null;
  readonly parentId?: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchSessionTimelineView {
  readonly session: WorkbenchSession;
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly timeline: readonly WorkbenchSessionTimelineItem[];
  readonly summaries: readonly WorkbenchSessionTemporalSummary[];
}

export interface WorkbenchBootstrapState {
  readonly ownerProfileCompleted: boolean;
  readonly sourceImportCompleted: boolean;
  readonly verificationCompleted: boolean;
  readonly onboardingCompletedAt?: string;
  readonly metadata: BootstrapMetadata;
  readonly updatedAt: string;
  readonly progress: {
    readonly completedSteps: number;
    readonly totalSteps: number;
    readonly onboardingComplete: boolean;
  };
}

export interface BootstrapMetadata {
  readonly brainPurposeMode?: BrainPurposeMode;
  readonly brainPurposeNotes?: string | null;
  readonly intelligenceSetupCompletedAt?: string;
  readonly intelligenceMode?: "external" | "openrouter" | "skip";
  readonly defaultNamespaceId?: string;
  readonly defaultLlmProvider?: WorkbenchModelProvider;
  readonly defaultLlmModel?: string | null;
  readonly defaultLlmPreset?: string | null;
  readonly defaultAsrModel?: string | null;
  readonly sourceDefaults?: {
    readonly intent?: SourceIntent;
    readonly monitorEnabled?: boolean;
    readonly scanSchedule?: string;
  };
  readonly ingestEmphasis?: string;
  readonly verificationHints?: readonly string[];
  readonly ownerBootstrapSessionId?: string;
  readonly ownerBootstrapStartedAt?: string;
  readonly ownerBootstrapCompletedAt?: string;
  readonly latestImportedSourceId?: string;
  readonly verificationCompletedAt?: string;
  readonly verificationSmokePackRunAt?: string;
  readonly verificationPassedCount?: number;
  readonly verificationSmokePack?: readonly BootstrapSmokePackItem[];
  readonly embeddingSettings?: WorkbenchEmbeddingSettings;
  readonly lastEmbeddingTest?: {
    readonly success: boolean;
    readonly provider: WorkbenchEmbeddingProvider;
    readonly model?: string | null;
    readonly dimensions?: number | null;
    readonly latencyMs?: number;
    readonly retrievalMode?: "lexical" | "hybrid";
    readonly reason?: string | null;
    readonly testedAt: string;
  };
  readonly lastEmbeddingRebuild?: {
    readonly success: boolean;
    readonly namespaceId: string;
    readonly provider: WorkbenchEmbeddingProvider;
    readonly model?: string | null;
    readonly semanticQueued?: number;
    readonly derivationQueued?: number;
    readonly reason?: string | null;
    readonly queuedAt: string;
  };
  readonly operationsSettings?: WorkbenchOperationsSettings;
  readonly [key: string]: unknown;
}

export interface WorkbenchEmbeddingSettings {
  readonly provider: WorkbenchEmbeddingProvider;
  readonly model?: string | null;
  readonly dimensions?: number | null;
  readonly normalize?: boolean;
  readonly instruction?: string | null;
}

export interface WorkbenchOperationsSettings {
  readonly sourceMonitor: {
    readonly enabled: boolean;
    readonly workerIntervalSeconds: number;
    readonly defaultScanSchedule: string;
    readonly autoImportOnScan: boolean;
  };
  readonly outbox: {
    readonly workerIntervalSeconds: number;
    readonly batchLimit: number;
  };
  readonly temporalSummary: {
    readonly enabled: boolean;
    readonly workerIntervalSeconds: number;
    readonly lookbackDays: number;
    readonly strategy: "deterministic" | "deterministic_plus_llm";
    readonly summarizerProvider: WorkbenchModelProvider;
    readonly summarizerModel?: string | null;
    readonly summarizerPreset?: string | null;
    readonly systemPrompt?: string | null;
  };
}

export interface WorkbenchSourceMonitorRunResult {
  readonly checkedAt: string;
  readonly importAfterScan: boolean;
  readonly dueSourceCount: number;
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly results: ReadonlyArray<{
    readonly sourceId: string;
    readonly label: string;
    readonly scanSchedule: string;
    readonly action: "imported" | "scanned" | "skipped" | "failed";
    readonly reason?: string;
    readonly importRunId?: string;
    readonly error?: string;
  }>;
}

export interface WorkbenchOutboxProcessResult {
  readonly scanned: number;
  readonly processed: number;
  readonly failed: number;
  readonly touchedNamespaces: readonly string[];
}

export interface WorkbenchTemporalSummaryProcessResult {
  readonly namespaceId: string;
  readonly layer: "day" | "week" | "month" | "year";
  readonly scannedBuckets: number;
  readonly upsertedNodes: number;
  readonly linkedMembers: number;
}

export interface WorkbenchWorkerRun {
  readonly id: string;
  readonly workerKey: "source_monitor" | "derivation" | "outbox" | "temporal_summary";
  readonly triggerType: "manual" | "scheduled" | "loop" | "onboarding" | "repair";
  readonly namespaceId?: string | null;
  readonly sourceId?: string | null;
  readonly workerId?: string | null;
  readonly status: "running" | "succeeded" | "partial" | "failed" | "skipped";
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly durationMs?: number | null;
  readonly nextDueAt?: string | null;
  readonly attemptedCount: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly errorClass?: string | null;
  readonly errorMessage?: string | null;
  readonly summary: Record<string, unknown>;
}

export interface WorkbenchWorkerHealth {
  readonly workerKey: "source_monitor" | "derivation" | "outbox" | "temporal_summary";
  readonly enabled: boolean;
  readonly intervalSeconds?: number;
  readonly state: "disabled" | "never" | "running" | "healthy" | "degraded" | "failed" | "stale";
  readonly nextDueAt?: string;
  readonly latestRun?: WorkbenchWorkerRun;
  readonly recentFailures: readonly WorkbenchWorkerRun[];
}

export interface WorkbenchRuntimeWorkerStatus {
  readonly checkedAt: string;
  readonly namespaceId: string;
  readonly workers: readonly WorkbenchWorkerHealth[];
}

export interface WorkbenchMonitoredSource {
  readonly id: string;
  readonly sourceType: "openclaw" | "folder";
  readonly namespaceId: string;
  readonly label: string;
  readonly rootPath: string;
  readonly includeSubfolders: boolean;
  readonly fileExtensions: readonly string[];
  readonly monitorEnabled: boolean;
  readonly scanSchedule: string;
  readonly status: "ready" | "disabled" | "error";
  readonly createdBy?: string;
  readonly notes?: string;
  readonly metadata: Record<string, unknown>;
  readonly lastScanAt?: string;
  readonly lastImportAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly counts: {
    readonly filesDiscovered: number;
    readonly filesImported: number;
    readonly filesPending: number;
  };
}

export type SourceIntent = "owner_bootstrap" | "ongoing_folder_monitor" | "historical_archive" | "project_source";

export interface WorkbenchMonitoredSourceFile {
  readonly id: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly contentHash?: string;
  readonly lastSeenAt: string;
  readonly existsNow: boolean;
  readonly artifactId?: string;
  readonly lastImportRunId?: string;
  readonly lastImportedHash?: string;
  readonly lastImportedAt?: string;
  readonly lastStatus: "new" | "changed" | "unchanged" | "deleted" | "imported" | "error";
  readonly errorMessage?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkbenchSourceRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "succeeded" | "partial" | "failed";
}

export interface WorkbenchSourcePreview {
  readonly source: WorkbenchMonitoredSource;
  readonly latestScan?: WorkbenchSourceRun & {
    readonly filesSeen: number;
    readonly newFiles: number;
    readonly changedFiles: number;
    readonly deletedFiles: number;
    readonly erroredFiles: number;
    readonly notes?: string;
    readonly result: Record<string, unknown>;
  };
  readonly latestImport?: WorkbenchSourceRun & {
    readonly triggerType: "manual" | "scheduled" | "onboarding";
    readonly filesAttempted: number;
    readonly filesImported: number;
    readonly filesSkipped: number;
    readonly filesFailed: number;
    readonly brainJobIds: readonly string[];
    readonly notes?: string;
    readonly result: Record<string, unknown>;
  };
  readonly preview: {
    readonly totalFiles: number;
    readonly markdownFiles: number;
    readonly textFiles: number;
    readonly newFiles: number;
    readonly changedFiles: number;
    readonly unchangedFiles: number;
    readonly deletedFiles: number;
    readonly erroredFiles: number;
    readonly estimatedTotalSizeBytes: number;
    readonly latestModifiedFile?: {
      readonly relativePath: string;
      readonly modifiedAt?: string;
    };
    readonly exampleMatchedPaths: readonly string[];
    readonly ignoredFiles: readonly string[];
  };
  readonly files: readonly WorkbenchMonitoredSourceFile[];
}

export interface WorkbenchSearchResult {
  readonly memoryId: string;
  readonly memoryType: string;
  readonly content: string;
  readonly score?: number;
  readonly artifactId?: string | null;
  readonly occurredAt?: string | null;
  readonly namespaceId: string;
  readonly provenance: Record<string, unknown>;
}

export interface WorkbenchSearchEvidence {
  readonly memoryId: string;
  readonly memoryType: string;
  readonly artifactId?: string | null;
  readonly occurredAt?: string | null;
  readonly sourceUri?: string | null;
  readonly snippet: string;
  readonly provenance: Record<string, unknown>;
}

export interface WorkbenchSearchResponse {
  readonly results: readonly WorkbenchSearchResult[];
  readonly evidence: readonly WorkbenchSearchEvidence[];
  readonly meta: Record<string, unknown>;
}

export interface WorkbenchSelfProfile {
  readonly namespaceId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly identityProfileId: string;
  readonly entityId: string;
  readonly metadata: Record<string, unknown>;
}

export interface WorkbenchClarificationItem {
  readonly candidateId: string;
  readonly claimType: string;
  readonly predicate: string;
  readonly targetRole: string;
  readonly rawText: string;
  readonly subjectText?: string;
  readonly objectText?: string;
  readonly confidence?: number;
  readonly priorScore?: number;
  readonly ambiguityType: string;
  readonly ambiguityReason?: string;
  readonly suggestedMatches: readonly string[];
  readonly occurredAt: string;
  readonly sceneText?: string;
  readonly sourceUri?: string;
  readonly priorityScore: number;
  readonly priorityLevel: 1 | 2 | 3;
  readonly priorityLabel: string;
  readonly priorityReasons: readonly string[];
}

export interface WorkbenchClarifications {
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly byType: Record<string, number>;
    readonly byPriority: Record<"priority_1" | "priority_2" | "priority_3", number>;
  };
  readonly items: readonly WorkbenchClarificationItem[];
  readonly available_actions: Record<string, string>;
}

interface WorkbenchClarificationWorkbenchEnvelope {
  readonly namespaceId: string;
  readonly inbox?: WorkbenchClarifications;
  readonly available_actions?: Record<string, string>;
}

export interface BootstrapSmokePackItem {
  readonly query: string;
  readonly label: string;
  readonly pass: boolean;
  readonly answer: string;
  readonly evidence: readonly {
    readonly sourceUri?: string | null;
    readonly snippet: string;
  }[];
  readonly namespaceId?: string;
}

export interface OpenRouterModelSummary {
  readonly id: string;
  readonly name: string;
  readonly supportsEmbeddings: boolean;
  readonly supportsChat: boolean;
  readonly contextLength?: number;
}

export interface WorkbenchEmbeddingTestResult {
  readonly ok: boolean;
  readonly success: boolean;
  readonly retrievalMode: "lexical" | "hybrid";
  readonly provider: WorkbenchEmbeddingProvider;
  readonly model?: string | null;
  readonly dimensions?: number | null;
  readonly latencyMs: number;
  readonly fallbackReason?: string;
  readonly normalized?: boolean;
  readonly tokenUsage?: Record<string, unknown>;
  readonly providerMetadata?: Record<string, unknown>;
}

export interface WorkbenchEmbeddingRebuildResult {
  readonly ok: boolean;
  readonly rebuild: {
    readonly namespaceId: string;
    readonly provider: string;
    readonly model: string;
    readonly semanticQueued: number;
    readonly derivationQueued: number;
  };
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(pathname, runtimeBaseUrl), {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `${pathname} returned ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fetchOpenRouterJson<T>(pathname: string): Promise<T> {
  if (!openRouterApiKey) {
    throw new Error("OpenRouter is not configured.");
  }

  const response = await fetch(new URL(pathname, openRouterBaseUrl), {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      "Content-Type": "application/json"
    }
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `${pathname} returned ${response.status}`);
  }

  return JSON.parse(raw) as T;
}

export function getWorkbenchRuntimeBaseUrl(): string {
  return runtimeBaseUrl;
}

export async function getRuntimeHealth(): Promise<{ readonly ok: boolean }> {
  return fetchJson<{ readonly ok: boolean }>("/health", { method: "GET", headers: {} });
}

export async function getWorkbenchWorkerStatus(): Promise<WorkbenchRuntimeWorkerStatus> {
  const payload = await fetchJson<{ readonly status: WorkbenchRuntimeWorkerStatus }>("/ops/workers", { method: "GET", headers: {} });
  return payload.status;
}

export async function getNamespaceCatalog(): Promise<{
  readonly defaultNamespaceId: string;
  readonly namespaces: readonly NamespaceChoice[];
}> {
  try {
    const catalog = await fetchJson<RuntimeNamespaceCatalog>("/ops/namespaces", { method: "GET", headers: {} });
    return {
      defaultNamespaceId: catalog.defaultNamespaceId ?? "personal",
      namespaces: catalog.namespaces
    };
  } catch {
    return {
      defaultNamespaceId: "personal",
      namespaces: []
    };
  }
}

export async function listWorkbenchSessions(): Promise<readonly WorkbenchSession[]> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSession>>("/ops/sessions", { method: "GET", headers: {} });
  return payload.sessions ?? [];
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSession>>(`/ops/sessions/${sessionId}`, { method: "GET", headers: {} });
  if (!payload.session) {
    throw new Error(`Session ${sessionId} not found.`);
  }
  return payload.session;
}

export async function createWorkbenchSession(input: {
  readonly title: string;
  readonly namespaceId: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly defaultLlmProvider?: WorkbenchModelProvider;
  readonly defaultLlmModel?: string;
  readonly defaultLlmPreset?: string;
  readonly defaultAsrModel?: string;
  readonly defaultEmbeddingProvider?: WorkbenchModelProvider;
  readonly defaultEmbeddingModel?: string;
}): Promise<WorkbenchSession> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSession>>("/ops/sessions", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      namespace_id: input.namespaceId,
      notes: input.notes ?? null,
      tags: input.tags ?? [],
      default_llm_provider: input.defaultLlmProvider ?? "external",
      default_llm_model: input.defaultLlmModel ?? null,
      default_llm_preset: input.defaultLlmPreset ?? null,
      default_asr_model: input.defaultAsrModel ?? null,
      default_embedding_provider: input.defaultEmbeddingProvider ?? "external",
      default_embedding_model: input.defaultEmbeddingModel ?? null
    })
  });

  if (!payload.session) {
    throw new Error("Runtime did not return a session payload.");
  }
  return payload.session;
}

export async function updateWorkbenchSession(
  sessionId: string,
  input: {
    readonly title?: string;
    readonly notes?: string | null;
    readonly tags?: readonly string[];
    readonly status?: string;
    readonly defaultAsrModel?: string | null;
    readonly defaultLlmProvider?: WorkbenchModelProvider | null;
    readonly defaultLlmModel?: string | null;
    readonly defaultLlmPreset?: string | null;
    readonly defaultEmbeddingProvider?: WorkbenchModelProvider | null;
    readonly defaultEmbeddingModel?: string | null;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<WorkbenchSession> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSession>>(`/ops/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: input.title,
      notes: input.notes,
      tags: input.tags,
      status: input.status,
      default_asr_model: input.defaultAsrModel,
      default_llm_provider: input.defaultLlmProvider,
      default_llm_model: input.defaultLlmModel,
      default_llm_preset: input.defaultLlmPreset,
      default_embedding_provider: input.defaultEmbeddingProvider,
      default_embedding_model: input.defaultEmbeddingModel,
      metadata: input.metadata ?? null
    })
  });

  if (!payload.session) {
    throw new Error(`Session ${sessionId} update payload missing.`);
  }
  return payload.session;
}

export async function submitWorkbenchTextIntake(input: {
  readonly sessionId: string;
  readonly label?: string;
  readonly text: string;
  readonly runClassification: boolean;
  readonly provider?: WorkbenchModelProvider;
  readonly model?: string;
  readonly presetId?: string;
  readonly maxOutputTokens?: number;
}): Promise<{
  readonly session: WorkbenchSession;
  readonly input: WorkbenchSessionInput;
  readonly artifactId: string;
  readonly classifiedChunks: number;
}> {
  return fetchJson<{
    readonly session: WorkbenchSession;
    readonly input: WorkbenchSessionInput;
    readonly artifactId: string;
    readonly classifiedChunks: number;
  }>(`/ops/sessions/${input.sessionId}/intake/text`, {
    method: "POST",
    body: JSON.stringify({
      label: input.label ?? null,
      text: input.text,
      run_classification: input.runClassification,
      classification: input.runClassification
        ? {
            provider: input.provider ?? null,
            model: input.model ?? null,
            preset_id: input.presetId ?? null,
            max_output_tokens: input.maxOutputTokens ?? null
          }
        : null
    })
  });
}

export async function getWorkbenchSessionReview(sessionId: string): Promise<SessionReview> {
  const payload = await fetchJson<JsonEnvelope<SessionReview>>(`/ops/sessions/${sessionId}/review`, {
    method: "GET",
    headers: {}
  });

  if (!payload.review) {
    throw new Error(`Review payload missing for session ${sessionId}.`);
  }
  return payload.review;
}

export async function getWorkbenchSessionTimeline(sessionId: string, limit = 40): Promise<WorkbenchSessionTimelineView> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSessionTimelineView>>(`/ops/sessions/${sessionId}/timeline?limit=${limit}`, {
    method: "GET",
    headers: {}
  });

  if (!payload.timeline) {
    throw new Error(`Timeline payload missing for session ${sessionId}.`);
  }
  return payload.timeline;
}

export async function getBootstrapState(): Promise<WorkbenchBootstrapState> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchBootstrapState>>("/ops/bootstrap-state", { method: "GET", headers: {} });
  if (!payload.bootstrap) {
    throw new Error("Bootstrap state payload missing.");
  }
  return payload.bootstrap;
}

export async function updateWorkbenchBootstrapState(input: {
  readonly ownerProfileCompleted?: boolean;
  readonly sourceImportCompleted?: boolean;
  readonly verificationCompleted?: boolean;
  readonly metadata?: BootstrapMetadata;
}): Promise<WorkbenchBootstrapState> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchBootstrapState>>("/ops/bootstrap-state", {
    method: "PATCH",
    body: JSON.stringify({
      owner_profile_completed: input.ownerProfileCompleted,
      source_import_completed: input.sourceImportCompleted,
      verification_completed: input.verificationCompleted,
      metadata: input.metadata ?? null
    })
  });

  if (!payload.bootstrap) {
    throw new Error("Bootstrap state payload missing.");
  }

  return payload.bootstrap;
}

export function resolveBootstrapEmbeddingSettings(metadata: BootstrapMetadata): WorkbenchEmbeddingSettings {
  const stored = metadata.embeddingSettings;
  if (stored && typeof stored === "object") {
    return {
      provider: stored.provider ?? "external",
      model: stored.model ?? null,
      dimensions: stored.dimensions ?? null,
      normalize: stored.normalize ?? false,
      instruction: stored.instruction ?? null
    };
  }

  return {
    provider: "external",
    model: null,
    dimensions: null,
    normalize: false,
    instruction: null
  };
}

export function resolveWorkbenchOperationsSettings(metadata: BootstrapMetadata): WorkbenchOperationsSettings {
  const defaultSummaryPrompt = `You are the AI Brain 2.0 Semantic Consolidator.

Write semantic day, week, month, and year summaries on top of deterministic temporal rollups for a local-first memory system.

Rules:
1. Ground every statement only in the supplied evidence and deterministic rollup.
2. Do not invent facts. If something is ambiguous or weakly supported, say so explicitly.
3. Preserve exact names, places, project titles, versions, and technical terms.
4. Compress repetition into stable themes without losing important exceptions or changes.
5. Treat provenance as mandatory. The final summary must remain compatible with explicit supporting memory IDs.
6. Normalize first-person phrasing into stable third-person memory language when helpful.
7. Prefer durable patterns, shifts, and active truth over noisy one-off details.

Return structured summary material only.`;
  const stored = metadata.operationsSettings;
  return {
    sourceMonitor: {
      enabled: stored?.sourceMonitor?.enabled ?? false,
      workerIntervalSeconds: stored?.sourceMonitor?.workerIntervalSeconds ?? 60,
      defaultScanSchedule: stored?.sourceMonitor?.defaultScanSchedule ?? "every_30_minutes",
      autoImportOnScan: stored?.sourceMonitor?.autoImportOnScan ?? true
    },
    outbox: {
      workerIntervalSeconds: stored?.outbox?.workerIntervalSeconds ?? 30,
      batchLimit: stored?.outbox?.batchLimit ?? 25
    },
    temporalSummary: {
      enabled: stored?.temporalSummary?.enabled ?? true,
      workerIntervalSeconds: stored?.temporalSummary?.workerIntervalSeconds ?? 300,
      lookbackDays: stored?.temporalSummary?.lookbackDays ?? 30,
      strategy: stored?.temporalSummary?.strategy ?? "deterministic",
      summarizerProvider: stored?.temporalSummary?.summarizerProvider ?? "external",
      summarizerModel: stored?.temporalSummary?.summarizerModel ?? null,
      summarizerPreset: stored?.temporalSummary?.summarizerPreset ?? null,
      systemPrompt: stored?.temporalSummary?.systemPrompt ?? defaultSummaryPrompt
    }
  };
}

export async function listWorkbenchSources(): Promise<readonly WorkbenchMonitoredSource[]> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchMonitoredSource>>("/ops/sources", { method: "GET", headers: {} });
  return payload.sources ?? [];
}

export async function createWorkbenchSource(input: {
  readonly sourceType: "openclaw" | "folder";
  readonly namespaceId?: string;
  readonly label?: string;
  readonly rootPath: string;
  readonly includeSubfolders?: boolean;
  readonly monitorEnabled?: boolean;
  readonly scanSchedule?: string;
  readonly notes?: string;
  readonly metadata?: Record<string, unknown>;
}): Promise<WorkbenchMonitoredSource> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchMonitoredSource>>("/ops/sources", {
    method: "POST",
    body: JSON.stringify({
      source_type: input.sourceType,
      namespace_id: input.namespaceId ?? null,
      label: input.label ?? null,
      root_path: input.rootPath,
      include_subfolders: input.includeSubfolders ?? true,
      monitor_enabled: input.monitorEnabled ?? false,
      scan_schedule: input.scanSchedule ?? null,
      notes: input.notes ?? null,
      metadata: input.metadata ?? null
    })
  });

  if (!payload.source) {
    throw new Error("Source payload missing.");
  }
  return payload.source;
}

export async function updateWorkbenchSource(
  sourceId: string,
  input: {
    readonly namespaceId?: string;
    readonly label?: string;
    readonly rootPath?: string;
    readonly includeSubfolders?: boolean;
    readonly monitorEnabled?: boolean;
    readonly scanSchedule?: string;
    readonly status?: "ready" | "disabled" | "error";
    readonly notes?: string | null;
    readonly metadata?: Record<string, unknown>;
  }
): Promise<WorkbenchMonitoredSource> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchMonitoredSource>>(`/ops/sources/${sourceId}`, {
    method: "PATCH",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      label: input.label,
      root_path: input.rootPath,
      include_subfolders: input.includeSubfolders,
      monitor_enabled: input.monitorEnabled,
      scan_schedule: input.scanSchedule,
      status: input.status,
      notes: input.notes,
      metadata: input.metadata ?? null
    })
  });

  if (!payload.source) {
    throw new Error(`Source ${sourceId} payload missing.`);
  }

  return payload.source;
}

export async function deleteWorkbenchSource(sourceId: string): Promise<void> {
  await fetchJson<{ readonly ok: boolean }>(`/ops/sources/${sourceId}`, {
    method: "DELETE",
    headers: {}
  });
}

export async function getWorkbenchSourcePreview(sourceId: string): Promise<WorkbenchSourcePreview> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSourcePreview>>(`/ops/sources/${sourceId}/preview`, {
    method: "GET",
    headers: {}
  });
  if (!payload.preview) {
    throw new Error(`Source preview missing for ${sourceId}.`);
  }
  return payload.preview;
}

export async function scanWorkbenchSource(sourceId: string): Promise<WorkbenchSourcePreview> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchSourcePreview>>(`/ops/sources/${sourceId}/scan`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (!payload.preview) {
    throw new Error(`Source scan preview missing for ${sourceId}.`);
  }
  return payload.preview;
}

export async function importWorkbenchSource(
  sourceId: string,
  triggerType: "manual" | "scheduled" | "onboarding" = "manual"
): Promise<{
  readonly source: WorkbenchMonitoredSource;
  readonly importRun: WorkbenchSourcePreview["latestImport"];
  readonly preview: WorkbenchSourcePreview;
}> {
  return fetchJson<{
    readonly source: WorkbenchMonitoredSource;
    readonly importRun: WorkbenchSourcePreview["latestImport"];
    readonly preview: WorkbenchSourcePreview;
  }>(`/ops/sources/${sourceId}/import`, {
    method: "POST",
    body: JSON.stringify({
      trigger_type: triggerType
    })
  });
}

export async function listWorkbenchSourceFiles(sourceId: string): Promise<readonly WorkbenchMonitoredSourceFile[]> {
  const payload = await fetchJson<JsonEnvelope<WorkbenchMonitoredSourceFile>>(`/ops/sources/${sourceId}/files`, {
    method: "GET",
    headers: {}
  });

  return payload.files ?? [];
}

export async function processWorkbenchSourceMonitor(input?: {
  readonly sourceId?: string;
  readonly scanOnly?: boolean;
  readonly limit?: number;
}): Promise<WorkbenchSourceMonitorRunResult> {
  const payload = await fetchJson<{ readonly monitorRun: WorkbenchSourceMonitorRunResult }>("/ops/sources/process", {
    method: "POST",
    body: JSON.stringify({
      source_id: input?.sourceId ?? null,
      scan_only: input?.scanOnly ?? false,
      limit: input?.limit ?? null
    })
  });
  return payload.monitorRun;
}

export async function searchWorkbenchMemory(input: {
  readonly query: string;
  readonly namespaceId?: string;
  readonly limit?: number;
  readonly provider?: WorkbenchEmbeddingProvider;
  readonly model?: string;
  readonly dimensions?: number;
}): Promise<WorkbenchSearchResponse> {
  const params = new URLSearchParams({
    query: input.query
  });

  if (input.namespaceId) {
    params.set("namespace_id", input.namespaceId);
  }

  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }
  if (input.provider) {
    params.set("provider", input.provider);
  }
  if (input.model) {
    params.set("model", input.model);
  }
  if (input.dimensions !== undefined) {
    params.set("dimensions", String(input.dimensions));
  }

  return fetchJson<WorkbenchSearchResponse>(`/search?${params.toString()}`, {
    method: "GET",
    headers: {}
  });
}

export async function getWorkbenchSelfProfile(namespaceId: string): Promise<WorkbenchSelfProfile | null> {
  try {
    return await fetchJson<WorkbenchSelfProfile>(`/ops/profile/self?${new URLSearchParams({ namespace_id: namespaceId }).toString()}`, {
      method: "GET",
      headers: {}
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }
    throw error;
  }
}

export async function saveWorkbenchSelfProfile(input: {
  readonly namespaceId: string;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
  readonly note?: string;
}): Promise<WorkbenchSelfProfile> {
  return fetchJson<WorkbenchSelfProfile>("/ops/profile/self", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      canonical_name: input.canonicalName,
      aliases: input.aliases ?? [],
      note: input.note ?? null
    })
  });
}

export async function getWorkbenchClarifications(namespaceId: string, limit = 10): Promise<WorkbenchClarifications> {
  const payload = await fetchJson<WorkbenchClarifications | WorkbenchClarificationWorkbenchEnvelope>(
    `/ops/clarifications?${new URLSearchParams({ namespace_id: namespaceId, limit: String(limit) }).toString()}`,
    {
      method: "GET",
      headers: {}
    }
  );

  if ("inbox" in payload && payload.inbox) {
    return {
      ...payload.inbox,
      available_actions: payload.available_actions ?? {}
    };
  }

  return payload as WorkbenchClarifications;
}

export async function listOpenRouterModels(): Promise<readonly OpenRouterModelSummary[]> {
  if (!openRouterApiKey) {
    return [];
  }

  const payload = await fetchOpenRouterJson<{ readonly data?: readonly Record<string, unknown>[] }>("/models");
  const models = Array.isArray(payload.data) ? payload.data : [];

  const normalized = models
    .map((record): OpenRouterModelSummary | undefined => {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) {
        return undefined;
      }

      const architecture =
        record.architecture && typeof record.architecture === "object" && !Array.isArray(record.architecture)
          ? (record.architecture as Record<string, unknown>)
          : undefined;
      const architectureModalities = architecture?.modality;
      const modalities = Array.isArray(architectureModalities)
        ? architectureModalities.filter((value: unknown): value is string => typeof value === "string")
        : [];
      const supportsEmbeddings =
        modalities.includes("embedding") ||
        id.includes("embedding") ||
        id.includes("embed");
      const supportsChat = modalities.includes("text") || !supportsEmbeddings;

      return {
        id,
        name: typeof record.name === "string" ? record.name : id,
        supportsEmbeddings,
        supportsChat,
        contextLength: typeof record.context_length === "number" ? record.context_length : undefined
      };
    })
    .filter((model): model is OpenRouterModelSummary => model !== undefined);

  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export async function testWorkbenchEmbeddings(input: {
  readonly provider: WorkbenchEmbeddingProvider;
  readonly model?: string;
  readonly dimensions?: number;
  readonly normalize?: boolean;
  readonly instruction?: string;
  readonly text?: string;
}): Promise<WorkbenchEmbeddingTestResult> {
  return fetchJson<WorkbenchEmbeddingTestResult>("/ops/embeddings/test", {
    method: "POST",
    body: JSON.stringify({
      provider: input.provider,
      model: input.model ?? null,
      dimensions: input.dimensions ?? null,
      normalize: input.normalize ?? false,
      instruction: input.instruction ?? null,
      text: input.text ?? null
    })
  });
}

export async function rebuildWorkbenchNamespaceEmbeddings(input: {
  readonly namespaceId: string;
  readonly provider: WorkbenchEmbeddingProvider;
  readonly model?: string;
  readonly dimensions?: number;
  readonly normalize?: boolean;
  readonly instruction?: string;
}): Promise<WorkbenchEmbeddingRebuildResult> {
  return fetchJson<WorkbenchEmbeddingRebuildResult>("/ops/embeddings/rebuild", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      provider: input.provider,
      model: input.model ?? null,
      dimensions: input.dimensions ?? null,
      normalize: input.normalize ?? false,
      instruction: input.instruction ?? null
    })
  });
}

export async function processWorkbenchOutbox(input: {
  readonly namespaceId?: string;
  readonly limit?: number;
}): Promise<WorkbenchOutboxProcessResult> {
  const payload = await fetchJson<{ readonly outbox: WorkbenchOutboxProcessResult }>("/ops/outbox/process", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId ?? null,
      limit: input.limit ?? null
    })
  });
  return payload.outbox;
}

export async function runWorkbenchTemporalSummaries(input: {
  readonly namespaceId: string;
  readonly lookbackDays?: number;
  readonly layers?: readonly ("day" | "week" | "month" | "year")[];
  readonly strategy?: "deterministic" | "deterministic_plus_llm";
  readonly provider?: WorkbenchModelProvider;
  readonly model?: string;
  readonly presetId?: string;
  readonly systemPrompt?: string;
}): Promise<{
  readonly summaries: readonly WorkbenchTemporalSummaryProcessResult[];
  readonly semanticOverlayUpdatedNodes: number;
}> {
  const payload = await fetchJson<{
    readonly summaries: readonly WorkbenchTemporalSummaryProcessResult[];
    readonly semanticOverlayUpdatedNodes?: number;
  }>("/ops/temporal/process", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      lookback_days: input.lookbackDays ?? null,
      layers: input.layers ?? null,
      strategy: input.strategy ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      preset_id: input.presetId ?? null,
      system_prompt: input.systemPrompt ?? null
    })
  });
  return {
    summaries: payload.summaries,
    semanticOverlayUpdatedNodes: payload.semanticOverlayUpdatedNodes ?? 0
  };
}

export async function resolveWorkbenchClarification(input: {
  readonly namespaceId: string;
  readonly candidateId: string;
  readonly targetRole: string;
  readonly canonicalName: string;
  readonly entityType: string;
  readonly aliases?: readonly string[];
  readonly note?: string;
}): Promise<void> {
  await fetchJson("/ops/inbox/resolve", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      candidate_id: input.candidateId,
      target_role: input.targetRole,
      canonical_name: input.canonicalName,
      entity_type: input.entityType,
      aliases: input.aliases ?? [],
      note: input.note ?? null
    })
  });
}

export async function ignoreWorkbenchClarification(input: {
  readonly namespaceId: string;
  readonly candidateId: string;
  readonly note?: string;
}): Promise<void> {
  await fetchJson("/ops/inbox/ignore", {
    method: "POST",
    body: JSON.stringify({
      namespace_id: input.namespaceId,
      candidate_id: input.candidateId,
      note: input.note ?? null
    })
  });
}
