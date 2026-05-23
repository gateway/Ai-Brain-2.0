import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_REGISTRY,
  legacyPatternForScript,
  loadPackageBenchmarkScripts,
  registryByScriptName,
  type BenchmarkRegistryEntry
} from "./benchmark-registry.js";
import { closePool } from "../db/client.js";

interface BenchmarkReliabilityAuditScriptRow {
  readonly scriptName: string;
  readonly command: string;
  readonly status: "registered" | "legacy" | "unregistered";
  readonly registryId: string | null;
  readonly legacyPatternId: string | null;
  readonly tier: string | null;
  readonly namespacePolicy: string | null;
  readonly productGateEligible: boolean;
  readonly mutatesDb: boolean | null;
}

interface BenchmarkReliabilityAuditReport {
  readonly generatedAt: string;
  readonly benchmark: "benchmark_reliability_audit";
  readonly artifactSchemaVersion: "benchmark_reliability_audit_v1";
  readonly passed: boolean;
  readonly metrics: {
    readonly benchmarkScriptCount: number;
    readonly registeredCount: number;
    readonly legacyCount: number;
    readonly unregisteredCount: number;
    readonly registryCoverageRate: number;
    readonly productGateCount: number;
    readonly productGateNamespacePolicyCoverageRate: number;
    readonly productGateArtifactSchemaCoverageRate: number;
    readonly productGateLatestArtifactUsageCount: number;
    readonly undeclaredSharedNamespaceMutationCount: number;
    readonly missingRequiredTelemetryProductGateCount: number;
    readonly auditLatencyMs: number;
  };
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly scripts: readonly BenchmarkReliabilityAuditScriptRow[];
  readonly registeredProductGates: readonly BenchmarkRegistryEntry[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function requiredTelemetryComplete(entry: BenchmarkRegistryEntry): boolean {
  if (!entry.productGateEligible) {
    return true;
  }
  return entry.requiredTelemetry.length > 0;
}

function scriptRow(scriptName: string, command: string, entry: BenchmarkRegistryEntry | undefined): BenchmarkReliabilityAuditScriptRow {
  if (entry) {
    return {
      scriptName,
      command,
      status: "registered",
      registryId: entry.id,
      legacyPatternId: null,
      tier: entry.tier,
      namespacePolicy: entry.namespacePolicy,
      productGateEligible: entry.productGateEligible,
      mutatesDb: entry.mutatesDb
    };
  }
  const legacy = legacyPatternForScript(scriptName);
  if (legacy) {
    return {
      scriptName,
      command,
      status: "legacy",
      registryId: null,
      legacyPatternId: legacy.id,
      tier: "legacy",
      namespacePolicy: null,
      productGateEligible: false,
      mutatesDb: null
    };
  }
  return {
    scriptName,
    command,
    status: "unregistered",
    registryId: null,
    legacyPatternId: null,
    tier: null,
    namespacePolicy: null,
    productGateEligible: false,
    mutatesDb: null
  };
}

function markdownReport(report: BenchmarkReliabilityAuditReport): string {
  const rows = report.scripts
    .map((entry) => `| ${entry.status} | ${entry.scriptName} | ${entry.tier ?? "-"} | ${entry.namespacePolicy ?? "-"} | ${entry.registryId ?? entry.legacyPatternId ?? "-"} |`)
    .join("\n");
  return `# Benchmark Reliability Audit

- generatedAt: ${report.generatedAt}
- passed: ${report.passed}
- benchmarkScriptCount: ${report.metrics.benchmarkScriptCount}
- registeredCount: ${report.metrics.registeredCount}
- legacyCount: ${report.metrics.legacyCount}
- unregisteredCount: ${report.metrics.unregisteredCount}
- registryCoverageRate: ${report.metrics.registryCoverageRate}
- productGateCount: ${report.metrics.productGateCount}
- productGateNamespacePolicyCoverageRate: ${report.metrics.productGateNamespacePolicyCoverageRate}
- productGateArtifactSchemaCoverageRate: ${report.metrics.productGateArtifactSchemaCoverageRate}
- productGateLatestArtifactUsageCount: ${report.metrics.productGateLatestArtifactUsageCount}

## Failures

${report.failures.map((failure) => `- ${failure}`).join("\n") || "- none"}

## Warnings

${report.warnings.map((warning) => `- ${warning}`).join("\n") || "- none"}

## Scripts

| status | script | tier | namespace policy | registry/legacy |
| --- | --- | --- | --- | --- |
${rows}
`;
}

export async function runBenchmarkReliabilityAudit(): Promise<BenchmarkReliabilityAuditReport> {
  const startedAt = performance.now();
  const scripts = await loadPackageBenchmarkScripts();
  const registry = registryByScriptName();
  const rows = Object.entries(scripts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scriptName, command]) => scriptRow(scriptName, command, registry.get(scriptName)));
  const productGates = BENCHMARK_REGISTRY.filter((entry) => entry.productGateEligible);
  const productGateNamespacePolicyCount = productGates.filter((entry) => Boolean(entry.namespacePolicy)).length;
  const productGateSchemaCount = productGates.filter((entry) => entry.artifactSchemaVersion.trim().length > 0).length;
  const productGateLatestArtifactUsageCount = productGates.filter((entry) => entry.canUseLatestArtifacts).length;
  const undeclaredSharedNamespaceMutationCount = productGates.filter(
    (entry) => entry.mutatesDb && entry.namespacePolicy === "shared_locked" && entry.fixturePolicy !== "existing_state_allowed"
  ).length;
  const missingRequiredTelemetryProductGateCount = productGates.filter((entry) => !requiredTelemetryComplete(entry)).length;
  const registeredCount = rows.filter((entry) => entry.status === "registered").length;
  const legacyCount = rows.filter((entry) => entry.status === "legacy").length;
  const unregisteredCount = rows.filter((entry) => entry.status === "unregistered").length;
  const metrics = {
    benchmarkScriptCount: rows.length,
    registeredCount,
    legacyCount,
    unregisteredCount,
    registryCoverageRate: rate(registeredCount + legacyCount, rows.length),
    productGateCount: productGates.length,
    productGateNamespacePolicyCoverageRate: rate(productGateNamespacePolicyCount, productGates.length),
    productGateArtifactSchemaCoverageRate: rate(productGateSchemaCount, productGates.length),
    productGateLatestArtifactUsageCount,
    undeclaredSharedNamespaceMutationCount,
    missingRequiredTelemetryProductGateCount,
    auditLatencyMs: Number((performance.now() - startedAt).toFixed(2))
  };
  const failures: string[] = [];
  const warnings: string[] = [];
  if (metrics.unregisteredCount > 0) failures.push("unregistered_benchmark_scripts");
  if (metrics.productGateNamespacePolicyCoverageRate < 1) failures.push("product_gate_namespace_policy_gap");
  if (metrics.productGateArtifactSchemaCoverageRate < 1) failures.push("product_gate_artifact_schema_gap");
  if (metrics.productGateLatestArtifactUsageCount > 0) failures.push("product_gate_latest_artifact_usage_allowed");
  if (metrics.undeclaredSharedNamespaceMutationCount > 0) failures.push("undeclared_shared_namespace_mutation");
  if (metrics.missingRequiredTelemetryProductGateCount > 0) failures.push("missing_product_gate_required_telemetry");
  if (metrics.legacyCount > 0) warnings.push("legacy_benchmarks_pending_full_governance_registration");

  return {
    generatedAt: new Date().toISOString(),
    benchmark: "benchmark_reliability_audit",
    artifactSchemaVersion: "benchmark_reliability_audit_v1",
    passed: failures.length === 0,
    metrics,
    failures,
    warnings,
    scripts: rows,
    registeredProductGates: productGates
  };
}

export async function runBenchmarkReliabilityAuditCli(): Promise<void> {
  try {
    const report = await runBenchmarkReliabilityAudit();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `benchmark-reliability-audit-${stamp}.json`);
    const markdownPath = path.join(dir, `benchmark-reliability-audit-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, markdownReport(report), "utf8");
    process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures, warnings: report.warnings }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
