import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BenchmarkTier = "unit" | "fixture" | "diagnostic" | "product_gate" | "scale_probe" | "artifact_finalizer";
export type BenchmarkNamespacePolicy = "isolated_required" | "shared_locked" | "read_only_artifact" | "external_dataset";
export type BenchmarkFixturePolicy = "deterministic_rebuild" | "existing_state_allowed" | "artifact_only";
export type BenchmarkProjectionPolicy = "none" | "rebuild_required" | "verify_only";
export type BenchmarkTelemetryKey =
  | "evidence_count"
  | "owner_count"
  | "query_time_model_calls"
  | "unsupported_no_evidence_count"
  | "latency"
  | "namespace_id";

export interface BenchmarkRegistryEntry {
  readonly id: string;
  readonly scriptName: string;
  readonly tier: BenchmarkTier;
  readonly mutatesDb: boolean;
  readonly namespacePolicy: BenchmarkNamespacePolicy;
  readonly fixturePolicy: BenchmarkFixturePolicy;
  readonly projectionPolicy: BenchmarkProjectionPolicy;
  readonly artifactSchemaVersion: string;
  readonly productGateEligible: boolean;
  readonly canUseLatestArtifacts: boolean;
  readonly requiredTelemetry: readonly BenchmarkTelemetryKey[];
}

export interface LegacyBenchmarkPattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const retrievalTelemetry: readonly BenchmarkTelemetryKey[] = [
  "evidence_count",
  "owner_count",
  "query_time_model_calls",
  "unsupported_no_evidence_count",
  "latency",
  "namespace_id"
];

export const BENCHMARK_REGISTRY: readonly BenchmarkRegistryEntry[] = [
  {
    id: "benchmark_reliability_audit",
    scriptName: "benchmark:benchmark-reliability-audit",
    tier: "diagnostic",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "artifact_only",
    projectionPolicy: "none",
    artifactSchemaVersion: "benchmark_reliability_audit_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["latency"]
  },
  {
    id: "clean_main_smoke_stack",
    scriptName: "benchmark:clean-main-smoke-stack",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "clean_main_smoke_stack_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "mcp_query_taxonomy_gold",
    scriptName: "benchmark:mcp-query-taxonomy-gold",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "mcp_query_taxonomy_gold_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "source_audit_cross_family_pack",
    scriptName: "benchmark:source-audit-cross-family-pack",
    tier: "fixture",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "artifact_only",
    projectionPolicy: "none",
    artifactSchemaVersion: "source_audit_cross_family_pack_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["evidence_count", "query_time_model_calls", "latency"]
  },
  {
    id: "temporal_memory_query_audit",
    scriptName: "benchmark:temporal-memory-query-audit",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "temporal_memory_query_audit_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "task_active_pruning_pack",
    scriptName: "benchmark:task-active-pruning-pack",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "task_active_pruning_pack_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "omi_task_calendar_window",
    scriptName: "benchmark:omi-task-calendar-window",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "omi_task_calendar_window_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "relationship_friend_set_pack",
    scriptName: "benchmark:relationship-friend-set-pack",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "relationship_friend_set_pack_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "mcp_correction_propagation_pack",
    scriptName: "benchmark:mcp-correction-propagation-pack",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "mcp_correction_propagation_pack_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "personal_omi_hard_query_audit_30",
    scriptName: "benchmark:personal-omi-hard-query-audit-30",
    tier: "product_gate",
    mutatesDb: false,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "personal_omi_hard_query_audit_30_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "mcp_human_query_audit_100",
    scriptName: "benchmark:mcp-human-query-audit-100",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "mcp_human_query_audit_100_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "projection_state_sentinel",
    scriptName: "benchmark:projection-state-sentinel",
    tier: "fixture",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "projection_state_sentinel_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "production_readiness",
    scriptName: "benchmark:production-readiness",
    tier: "artifact_finalizer",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "artifact_only",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "production_readiness_v2",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "relationship_map_projection_coverage",
    scriptName: "benchmark:relationship-map-projection-coverage",
    tier: "fixture",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "relationship_map_projection_coverage_v2",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "alias_current_state_projection_coverage",
    scriptName: "benchmark:alias-current-state-projection-coverage",
    tier: "fixture",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "alias_current_state_projection_coverage_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "natural_query_source_gap_coverage",
    scriptName: "benchmark:natural-query-source-gap-coverage",
    tier: "diagnostic",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "natural_query_source_gap_coverage_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "human_query_contract_routing",
    scriptName: "benchmark:human-query-contract-routing",
    tier: "fixture",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "human_query_contract_routing_v1",
    productGateEligible: false,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "personal_omi_review",
    scriptName: "benchmark:personal-omi-review",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "shared_locked",
    fixturePolicy: "existing_state_allowed",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "personal_omi_review_v2",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "locomo_release_candidate",
    scriptName: "benchmark:locomo:release-candidate",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "locomo_release_candidate_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "longmemeval",
    scriptName: "benchmark:longmemeval",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "longmemeval_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "omi_watch",
    scriptName: "benchmark:omi-watch",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "omi_watch_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "omi_extraction_shadow",
    scriptName: "benchmark:omi-extraction-shadow",
    tier: "product_gate",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "none",
    artifactSchemaVersion: "omi_extraction_shadow_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["query_time_model_calls", "unsupported_no_evidence_count", "latency"]
  },
  {
    id: "compiler_cache_profile",
    scriptName: "benchmark:compiler-cache-profile",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "none",
    artifactSchemaVersion: "compiler_cache_profile_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["latency"]
  },
  {
    id: "temporal_semantic_mini",
    scriptName: "benchmark:temporal-semantic-mini",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "rebuild_required",
    artifactSchemaVersion: "temporal_semantic_mini_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: retrievalTelemetry
  },
  {
    id: "ingestion_routing_coverage",
    scriptName: "benchmark:ingestion-routing-coverage",
    tier: "product_gate",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "none",
    artifactSchemaVersion: "ingestion_routing_coverage_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["latency", "namespace_id"]
  },
  {
    id: "ingestion_db_coverage",
    scriptName: "benchmark:ingestion-db-coverage",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "ingestion_db_coverage_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["latency", "namespace_id"]
  },
  {
    id: "ingestion_torture_corpus",
    scriptName: "benchmark:ingestion-torture-corpus",
    tier: "product_gate",
    mutatesDb: true,
    namespacePolicy: "isolated_required",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "verify_only",
    artifactSchemaVersion: "ingestion_torture_corpus_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["latency", "namespace_id"]
  },
  {
    id: "gliner_relex_cross_ingest_bakeoff",
    scriptName: "benchmark:gliner-relex-cross-ingest-bakeoff",
    tier: "product_gate",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "none",
    artifactSchemaVersion: "gliner_relex_cross_ingest_bakeoff_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["query_time_model_calls", "latency"]
  },
  {
    id: "gliner_relex_promotion_dry_run",
    scriptName: "benchmark:gliner-relex-promotion-dry-run",
    tier: "product_gate",
    mutatesDb: false,
    namespacePolicy: "read_only_artifact",
    fixturePolicy: "deterministic_rebuild",
    projectionPolicy: "none",
    artifactSchemaVersion: "gliner_relex_promotion_dry_run_v1",
    productGateEligible: true,
    canUseLatestArtifacts: false,
    requiredTelemetry: ["query_time_model_calls", "latency"]
  }
];

export const LEGACY_BENCHMARK_PATTERNS: readonly LegacyBenchmarkPattern[] = [
  {
    id: "lane_wrappers",
    pattern: /^benchmark:lane:/u,
    reason: "lane wrappers delegate to registered underlying benchmark commands"
  },
  {
    id: "artifact_and_diagnostic_backlog",
    pattern: /^benchmark:(?!benchmark-reliability-audit$|projection-state-sentinel$).+/u,
    reason: "legacy diagnostic benchmark pending full governance registration"
  }
];

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function loadPackageBenchmarkScripts(): Promise<Readonly<Record<string, string>>> {
  const packagePath = path.join(localBrainRoot(), "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { readonly scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};
  return Object.fromEntries(Object.entries(scripts).filter(([scriptName]) => scriptName.startsWith("benchmark:")));
}

export function registryByScriptName(): ReadonlyMap<string, BenchmarkRegistryEntry> {
  return new Map(BENCHMARK_REGISTRY.map((entry) => [entry.scriptName, entry]));
}

export function legacyPatternForScript(scriptName: string): LegacyBenchmarkPattern | null {
  return LEGACY_BENCHMARK_PATTERNS.find((entry) => entry.pattern.test(scriptName)) ?? null;
}
