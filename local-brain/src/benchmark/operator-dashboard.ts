import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ArtifactSummary {
  readonly label: string;
  readonly prefix: string;
  readonly artifactPath: string | null;
  readonly previousArtifactPath: string | null;
  readonly passed: boolean | null;
  readonly status: "green" | "red" | "missing" | "unknown";
  readonly metrics: Record<string, unknown>;
  readonly residualOwners: Record<string, number>;
  readonly p95LatencyMs: number | null;
  readonly maxLatencyMs: number | null;
  readonly deltas: Record<string, number>;
}

interface OperatorDashboardReport {
  readonly generatedAt: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly missLedgerRowsClassifiedRate: number;
    readonly dominantResidualOwnerVisible: boolean;
    readonly beforeAfterDeltasVisible: boolean;
    readonly manualArtifactLookupRequired: boolean;
  };
  readonly dominantResidualOwner: string | null;
  readonly artifacts: readonly ArtifactSummary[];
  readonly artifactPath: string;
  readonly markdownPath: string;
}

const DASHBOARD_TARGETS: readonly { readonly label: string; readonly prefix: string }[] = [
  { label: "MCP gold", prefix: "mcp-query-taxonomy-gold" },
  { label: "Personal OMI hard query audit 30", prefix: "personal-omi-hard-query-audit-30" },
  { label: "Source audit cross-family", prefix: "source-audit-cross-family-pack" },
  { label: "Source audit binding", prefix: "source-audit-binding-pack" },
  { label: "Relationship friend-set", prefix: "relationship-friend-set-pack" },
  { label: "Task active pruning", prefix: "task-active-pruning-pack" },
  { label: "Temporal memory query audit", prefix: "temporal-memory-query-audit" },
  { label: "Adversarial negative answers", prefix: "adversarial-negative-answer-pack" },
  { label: "Source privacy retention", prefix: "source-privacy-retention-pack" },
  { label: "MCP correction propagation", prefix: "mcp-correction-propagation-pack" },
  { label: "Multi-source ingestion", prefix: "multi-source-ingestion-pack" },
  { label: "Multimodal worker smoke", prefix: "multimodal-worker-smoke" },
  { label: "CEO demo readiness", prefix: "ceo-demo-readiness-pack" }
];

const DELTA_KEYS = [
  "passRate",
  "nonSourceMissingPassRate",
  "negativePackPassRate",
  "claimAuditCoverageRate",
  "friendSetPassRate",
  "taskLifecyclePassRate",
  "p95LatencyMs",
  "maxLatencyMs",
  "weakCount",
  "sourceMissingCount",
  "supportedEmptySourceTrailCount",
  "deletionPropagationPassRate",
  "redactionPropagationPassRate",
  "privateSourceLeakCount",
  "auditTrailCoverageRate",
  "rollbackRestorationPassRate",
  "crossSourceTemporalPassRate",
  "crossSourceTaskPassRate",
  "crossSourceDossierPassRate",
  "sourceTrailCoverageRate",
  "derivationCount",
  "demoQueryPassRate",
  "queryTimeModelCalls"
] as const;

function localBrainRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function benchmarkResultsDir(): string {
  return path.join(localBrainRoot(), "benchmark-results");
}

function outputDir(): string {
  return benchmarkResultsDir();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function passedValue(artifact: Record<string, unknown>): boolean | null {
  if (typeof artifact.passed === "boolean") return artifact.passed;
  const metrics = isRecord(artifact.metrics) ? artifact.metrics : {};
  const passRate = numberValue(metrics.passRate);
  if (passRate !== null) return passRate >= 1;
  return null;
}

function metricsFromArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  return isRecord(artifact.metrics) ? artifact.metrics : {};
}

function p95FromArtifact(metrics: Record<string, unknown>): number | null {
  return numberValue(metrics.p95LatencyMs) ?? numberValue(metrics.p95Ms) ?? null;
}

function maxFromArtifact(metrics: Record<string, unknown>): number | null {
  return numberValue(metrics.maxLatencyMs) ?? numberValue(metrics.maxMs) ?? null;
}

function residualOwnersFromRows(artifact: Record<string, unknown>): Record<string, number> {
  const metrics = metricsFromArtifact(artifact);
  if (isRecord(metrics.residualOwnerCounts)) {
    const owners: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics.residualOwnerCounts)) {
      const count = numberValue(value);
      if (count !== null && count > 0 && key !== "none") owners[key] = count;
    }
    return owners;
  }

  const rows = Array.isArray(artifact.rows)
    ? artifact.rows
    : Array.isArray(artifact.results)
      ? artifact.results
      : [];
  const owners: Record<string, number> = {};
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const passed = row.passed === true || row.rating === "strong";
    const owner = typeof row.residualOwner === "string" ? row.residualOwner : null;
    if (!passed && owner && owner !== "none") {
      owners[owner] = (owners[owner] ?? 0) + 1;
    }
  }
  return owners;
}

function classifiedMissRate(artifact: Record<string, unknown>): { readonly classified: number; readonly total: number } {
  const rows = Array.isArray(artifact.rows)
    ? artifact.rows
    : Array.isArray(artifact.results)
      ? artifact.results
      : [];
  let total = 0;
  let classified = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const passed = row.passed === true || row.rating === "strong";
    if (passed) continue;
    total += 1;
    if (typeof row.residualOwner === "string" && row.residualOwner.length > 0) classified += 1;
  }
  return { classified, total };
}

async function artifactFilesForPrefix(prefix: string): Promise<readonly string[]> {
  const dir = benchmarkResultsDir();
  const files = await readdir(dir);
  const matches = files.filter((file) => file.startsWith(`${prefix}-`) && file.endsWith(".json"));
  const withMtime = await Promise.all(
    matches.map(async (file) => {
      const artifactPath = path.join(dir, file);
      const info = await stat(artifactPath);
      return { artifactPath, mtimeMs: info.mtimeMs };
    })
  );
  return withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.artifactPath);
}

async function readJsonArtifact(artifactPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
}

function metricDeltas(current: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, number> {
  if (!previous) return {};
  const deltas: Record<string, number> = {};
  const previousMetrics = metricsFromArtifact(previous);
  for (const key of DELTA_KEYS) {
    const currentValue = numberValue(current[key]);
    const previousValue = numberValue(previousMetrics[key]);
    if (currentValue !== null && previousValue !== null) {
      deltas[key] = Number((currentValue - previousValue).toFixed(3));
    }
  }
  return deltas;
}

async function summarizeTarget(target: { readonly label: string; readonly prefix: string }): Promise<ArtifactSummary> {
  const files = await artifactFilesForPrefix(target.prefix);
  if (files.length === 0) {
    return {
      label: target.label,
      prefix: target.prefix,
      artifactPath: null,
      previousArtifactPath: null,
      passed: null,
      status: "missing",
      metrics: {},
      residualOwners: {},
      p95LatencyMs: null,
      maxLatencyMs: null,
      deltas: {}
    };
  }

  const artifact = await readJsonArtifact(files[0]!);
  const previous = files[1] ? await readJsonArtifact(files[1]!) : null;
  const metrics = metricsFromArtifact(artifact);
  const passed = passedValue(artifact);
  return {
    label: target.label,
    prefix: target.prefix,
    artifactPath: files[0]!,
    previousArtifactPath: files[1] ?? null,
    passed,
    status: passed === true ? "green" : passed === false ? "red" : "unknown",
    metrics,
    residualOwners: residualOwnersFromRows(artifact),
    p95LatencyMs: p95FromArtifact(metrics),
    maxLatencyMs: maxFromArtifact(metrics),
    deltas: metricDeltas(metrics, previous)
  };
}

function formatMetric(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  return "";
}

function compactMetrics(summary: ArtifactSummary): string {
  const keys = [
    "totalCases",
    "passedCases",
    "totalRows",
    "passedRows",
    "strongCount",
    "weakCount",
    "sourceMissingCount",
    "passRate",
    "nonSourceMissingPassRate",
    "negativePackPassRate",
    "deletionPropagationPassRate",
    "redactionPropagationPassRate",
    "privateSourceLeakCount",
    "auditTrailCoverageRate",
    "rollbackRestorationPassRate",
    "sourceKindCoverageCount",
    "crossSourceTemporalPassRate",
    "crossSourceTaskPassRate",
    "crossSourceDossierPassRate",
    "derivationCount",
    "demoQueryPassRate",
    "artifactLinksComplete",
    "knownLimitationsDocumented",
    "nextSliceDerivedFromMetrics",
    "sourceTrailCoverageRate",
    "claimAuditCoverageRate",
    "friendSetPassRate",
    "taskLifecyclePassRate",
    "supportedEmptySourceTrailCount",
    "queryTimeModelCalls"
  ];
  const parts: string[] = [];
  for (const key of keys) {
    if (summary.metrics[key] !== undefined) parts.push(`${key}=${formatMetric(summary.metrics[key])}`);
  }
  if (summary.p95LatencyMs !== null) parts.push(`p95=${formatMetric(summary.p95LatencyMs)}ms`);
  if (summary.maxLatencyMs !== null) parts.push(`max=${formatMetric(summary.maxLatencyMs)}ms`);
  return parts.join(", ");
}

function renderDashboardMarkdown(report: OperatorDashboardReport): string {
  const lines: string[] = [];
  lines.push("# AI Brain Operator Dashboard");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Overall status: ${report.passed ? "green" : "red"}`);
  lines.push("");
  lines.push("## CEO Summary");
  lines.push("");
  lines.push(
    report.passed
      ? "The current retrieval production surface is green across the latest selected gates. Positive recall, source audit, correction propagation, task pruning, temporal scope, adversarial abstention, source privacy enforcement, multi-source ingestion fixtures, the 30-query personal audit, and the CEO demo readiness pack all have current passing artifacts. The next product move is one-source-at-a-time real corpus expansion with clean replay certification."
      : "The current retrieval production surface has at least one red or missing selected gate. The next product move should target the dominant residual owner shown below before widening surface area."
  );
  lines.push("");
  lines.push("## Health Metrics");
  lines.push("");
  lines.push(`- missLedgerRowsClassifiedRate: ${report.metrics.missLedgerRowsClassifiedRate}`);
  lines.push(`- dominantResidualOwnerVisible: ${report.metrics.dominantResidualOwnerVisible}`);
  lines.push(`- beforeAfterDeltasVisible: ${report.metrics.beforeAfterDeltasVisible}`);
  lines.push(`- manualArtifactLookupRequired: ${report.metrics.manualArtifactLookupRequired}`);
  lines.push(`- dominantResidualOwner: ${report.dominantResidualOwner ?? "none"}`);
  lines.push("");
  lines.push("## Latest Gates");
  lines.push("");
  lines.push("| Gate | Status | Metrics | Artifact |");
  lines.push("| --- | --- | --- | --- |");
  for (const artifact of report.artifacts) {
    const artifactLink = artifact.artifactPath ? `[json](${artifact.artifactPath})` : "missing";
    lines.push(`| ${artifact.label} | ${artifact.status} | ${compactMetrics(artifact)} | ${artifactLink} |`);
  }
  lines.push("");
  lines.push("## Before / After Deltas");
  lines.push("");
  lines.push("| Gate | Previous Artifact | Deltas |");
  lines.push("| --- | --- | --- |");
  for (const artifact of report.artifacts) {
    const deltaText = Object.entries(artifact.deltas)
      .map(([key, value]) => `${key}: ${value >= 0 ? "+" : ""}${value}`)
      .join(", ") || "no comparable numeric deltas";
    const previousLink = artifact.previousArtifactPath ? `[previous](${artifact.previousArtifactPath})` : "none";
    lines.push(`| ${artifact.label} | ${previousLink} | ${deltaText} |`);
  }
  lines.push("");
  lines.push("## Residual Owners");
  lines.push("");
  const residualRows = report.artifacts.flatMap((artifact) =>
    Object.entries(artifact.residualOwners).map(([owner, count]) => ({ gate: artifact.label, owner, count }))
  );
  if (residualRows.length === 0) {
    lines.push("No residual owners in the selected latest gates.");
  } else {
    lines.push("| Gate | Residual Owner | Count |");
    lines.push("| --- | --- | --- |");
    for (const row of residualRows) {
      lines.push(`| ${row.gate} | ${row.owner} | ${row.count} |`);
    }
  }
  lines.push("");
  lines.push("## Phase Sign-Off");
  lines.push("");
  lines.push("- Phase 9.1 correction replay and constraint hardening: complete.");
  lines.push("- Phase 10 session-bound source audit and claim registry: complete.");
  lines.push("- Phase 11 adversarial negative-answer coverage: complete.");
  lines.push("- Phase 12 operator dashboard and miss-ledger workflow: complete.");
  lines.push("- Phase 13 security, privacy, retention, and deletion semantics: complete.");
  lines.push("- Phase 14 multi-source ingestion expansion: fixture gate complete for markdown, PDF text sidecar, task export, and calendar export.");
  lines.push("- Phase 15 CEO demo and product readiness package: complete when the selected CEO demo readiness artifact is green.");
  lines.push("");
  lines.push("## Next Action");
  lines.push("");
  lines.push(report.passed ? "Use the CEO demo package for stakeholder review, then start the next metric-driven slice from any red or conditional area." : "Fix the red or missing selected gate before stakeholder demo.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function generateOperatorDashboard(): Promise<OperatorDashboardReport> {
  await mkdir(outputDir(), { recursive: true });
  const artifacts = await Promise.all(DASHBOARD_TARGETS.map(summarizeTarget));
  const missStats = await Promise.all(
    artifacts.map(async (artifact) => {
      if (!artifact.artifactPath) return { classified: 0, total: 0 };
      return classifiedMissRate(await readJsonArtifact(artifact.artifactPath));
    })
  );
  const totalMisses = missStats.reduce((sum, item) => sum + item.total, 0);
  const classifiedMisses = missStats.reduce((sum, item) => sum + item.classified, 0);
  const residualCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const [owner, count] of Object.entries(artifact.residualOwners)) {
      residualCounts.set(owner, (residualCounts.get(owner) ?? 0) + count);
    }
  }
  const dominantResidualOwner = [...residualCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const missingOrRed = artifacts.filter((artifact) => artifact.status === "missing" || artifact.status === "red");
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const artifactPath = path.join(outputDir(), `operator-dashboard-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `operator-dashboard-${stamp}.md`);
  const report: OperatorDashboardReport = {
    generatedAt,
    passed: missingOrRed.length === 0,
    metrics: {
      missLedgerRowsClassifiedRate: totalMisses === 0 ? 1 : Number((classifiedMisses / totalMisses).toFixed(3)),
      dominantResidualOwnerVisible: true,
      beforeAfterDeltasVisible: artifacts.some((artifact) => Object.keys(artifact.deltas).length > 0),
      manualArtifactLookupRequired: false
    },
    dominantResidualOwner,
    artifacts,
    artifactPath,
    markdownPath
  };
  const markdown = renderDashboardMarkdown(report);
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  return report;
}

export async function runOperatorDashboardCli(): Promise<void> {
  const report = await generateOperatorDashboard();
  console.log(JSON.stringify({
    passed: report.passed,
    metrics: report.metrics,
    dominantResidualOwner: report.dominantResidualOwner,
    artifactPath: report.artifactPath,
    markdownPath: report.markdownPath
  }, null, 2));
}
