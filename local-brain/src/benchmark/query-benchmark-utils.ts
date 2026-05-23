import path from "node:path";
import { fileURLToPath } from "node:url";

export function benchmarkOutputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

export function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
}

export function payloadEvidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence;
  if (Array.isArray(payload?.evidence)) return payload.evidence;
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  return [];
}

export function payloadEvidenceCount(payload: any): number {
  return payloadEvidenceItems(payload).length;
}

export function answerTextFromPayload(payload: any, toolName = "memory.search"): string {
  if (toolName === "memory.extract_tasks") {
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    return tasks
      .map((task: any) => (typeof task?.title === "string" ? task.title : typeof task?.text === "string" ? task.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  if (typeof payload?.summaryText === "string") return payload.summaryText;
  return "";
}

export function queryTimeModelCallsFromPayload(payload: any): number {
  if (payload?.meta?.queryTimeGLiNEROrLLMUsed === true) return 1;
  if (typeof payload?.meta?.queryTimeModelCalls === "number") return payload.meta.queryTimeModelCalls;
  return 0;
}

export function projectionRuntimeFlags(): Record<string, string | undefined> {
  return {
    BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION: process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION,
    BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION: process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION,
    BRAIN_ENABLE_SHARED_SOCIAL_GRAPH: process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH,
    BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION: process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION,
    BRAIN_ENABLE_RECAP_PROFILE_PROJECTION: process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION
  };
}

export function applyProjectionRuntimeFlags(): void {
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION = "1";
  process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH = "1";
  process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION = "1";
  process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION = "1";
}

export function restoreProjectionRuntimeFlags(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function vectorRuntimeFlags(): Record<string, string | undefined> {
  return {
    BRAIN_RUNTIME_VECTOR_ACTIVATION_MODE: process.env.BRAIN_RUNTIME_VECTOR_ACTIVATION_MODE,
    BRAIN_BENCHMARK_VECTOR_ACTIVATION_MODE: process.env.BRAIN_BENCHMARK_VECTOR_ACTIVATION_MODE
  };
}

export function applyVectorRuntimeFlags(params: {
  readonly runtimeMode: "off" | "queue_only" | "bounded" | "full";
  readonly benchmarkMode: "off" | "queue_only" | "bounded" | "full";
}): void {
  process.env.BRAIN_RUNTIME_VECTOR_ACTIVATION_MODE = params.runtimeMode;
  process.env.BRAIN_BENCHMARK_VECTOR_ACTIVATION_MODE = params.benchmarkMode;
}

export function restoreVectorRuntimeFlags(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
