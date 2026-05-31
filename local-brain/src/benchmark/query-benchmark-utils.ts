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

function normalizeTermText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function hasTerm(value: unknown, term: string): boolean {
  const normalizedValue = ` ${normalizeTermText(JSON.stringify(value ?? null))} `;
  const normalizedTerm = normalizeTermText(term);
  if (!normalizedTerm) {
    return false;
  }
  const variants = new Set([normalizedTerm]);
  if (/ing$/u.test(normalizedTerm) && normalizedTerm.length > 5 && !normalizedTerm.includes(" ")) {
    variants.add(normalizedTerm.replace(/ing$/u, ""));
  }
  // Short tokens like "RV" and "US" must not match arbitrary substrings inside
  // metadata words. Longer single words can still use substring matching to
  // tolerate small presentational differences.
  if (normalizedTerm.length <= 3 || normalizedTerm.includes(" ")) {
    return [...variants].some((variant) => normalizedValue.includes(` ${variant} `));
  }
  return [...variants].some((variant) => normalizedValue.includes(variant));
}

export function payloadEvidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) return payload.duality.evidence;
  if (Array.isArray(payload?.evidence)) return payload.evidence;
  if (Array.isArray(payload?.tasks)) return payload.tasks;
  if (Array.isArray(payload?.commitments)) return payload.commitments;
  if (Array.isArray(payload?.sourceTrail)) return payload.sourceTrail;
  return [];
}

export function payloadEvidenceCount(payload: any): number {
  if (typeof payload?.evidenceCount === "number" && Number.isFinite(payload.evidenceCount)) {
    return payload.evidenceCount;
  }
  return payloadEvidenceItems(payload).length;
}

export function answerTextFromPayload(payload: any, toolName = "memory.search"): string {
  if (payload?.humanReadable && typeof payload.humanReadable === "object" && typeof payload.humanReadable.answer === "string") {
    return payload.humanReadable.answer;
  }
  if (typeof payload?.humanReadable === "string") return payload.humanReadable;
  if (typeof payload?.answer === "string") return payload.answer;
  if (toolName === "memory.extract_tasks") {
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    return tasks
      .map((task: any) => (typeof task?.title === "string" ? task.title : typeof task?.text === "string" ? task.text : ""))
      .filter(Boolean)
      .join("; ");
  }
  if (toolName === "memory.extract_calendar") {
    const commitments = Array.isArray(payload?.commitments) ? payload.commitments : [];
    return commitments
      .map((commitment: any) => (typeof commitment?.title === "string" ? commitment.title : typeof commitment?.text === "string" ? commitment.text : ""))
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
  if (typeof payload?.queryTimeModelCalls === "number") return payload.queryTimeModelCalls;
  if (typeof payload?.insightVerification?.queryTimeModelCalls === "number") return payload.insightVerification.queryTimeModelCalls;
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
