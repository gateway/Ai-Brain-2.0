import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { upsertNamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalNodeArchival, runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { getOpsClarificationInbox, getOpsRelationshipGraph } from "../ops/service.js";
import { executeProvenanceAuditWorker } from "../ops/runtime-worker-service.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  importMonitoredSource,
  listMonitoredSources,
  processScheduledMonitoredSources,
  scanMonitoredSource
} from "../ops/source-service.js";
import { searchMemory } from "../retrieval/service.js";
import { omiWatchFixtureRoot, prepareOmiWatchFixtureRoot } from "./omi-watch-fixture.js";

type Confidence = "confident" | "weak" | "missing";

interface OmiWatchQuerySpec {
  readonly name: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly minimumConfidence: Confidence;
}

interface OmiWatchQueryResult {
  readonly name: string;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: Confidence;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly finalRouteFamily: string | null;
  readonly sourceBoundedReadTried: boolean | null;
  readonly sourceBoundedReadSucceeded: boolean | null;
  readonly relationshipFastPathTried: boolean | null;
  readonly relationshipFastPathSucceeded: boolean | null;
  readonly candidateCountsByStage: Readonly<Record<string, number>> | null;
  readonly rowsScannedByStage: Readonly<Record<string, number>> | null;
  readonly earlyStopReason: string | null;
  readonly fallbackReason: string | null;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface OmiWatchGraphCheck {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly highlightedNames: readonly string[];
}

interface OmiWatchImportFileProgress {
  readonly fileId: string;
  readonly relativePath: string;
  readonly status: string;
  readonly filesAttempted: number;
  readonly filesImported: number;
  readonly filesFailed: number;
  readonly stageMs: number;
  readonly error: string | null;
}

export interface OmiWatchSmokeReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly source: {
    readonly id: string;
    readonly label: string;
    readonly rootPath: string;
    readonly monitorEnabled: boolean;
    readonly scanSchedule: string;
  };
  readonly firstScan: {
    readonly totalFiles: number;
    readonly markdownFiles: number;
    readonly ignoredFiles: readonly string[];
  };
  readonly importRun: {
    readonly status: string;
    readonly filesAttempted: number;
    readonly filesImported: number;
    readonly filesFailed: number;
  };
  readonly importFiles: readonly OmiWatchImportFileProgress[];
  readonly scheduledMonitorCheck: {
    readonly status: string;
    readonly dueSourceCount: number;
    readonly processedCount: number;
    readonly actions: readonly string[];
  };
  readonly stageTimingsMs: Readonly<Record<string, number>>;
  readonly blockedStage: string | null;
  readonly blockedStageReason: string | null;
  readonly queries: readonly OmiWatchQueryResult[];
  readonly graph: OmiWatchGraphCheck;
  readonly clarifications: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly productionReadiness: {
    readonly correctness: {
      readonly omiWatchPassRate: string;
    };
    readonly latency: {
      readonly omiWatchP50Ms: number;
      readonly omiWatchP95Ms: number;
      readonly omiWatchMaxMs: number;
    };
    readonly routePurity: {
      readonly directRouteSuccessCountByFamily: Readonly<Record<string, number>>;
      readonly slowRowsMissingRouteOwnerCount: number;
    };
  };
  readonly passed: boolean;
}

interface MutableOmiWatchSmokeState {
  namespaceId: string;
  source: OmiWatchSmokeReport["source"];
  firstScan: OmiWatchSmokeReport["firstScan"];
  importRun: OmiWatchSmokeReport["importRun"];
  importFiles: OmiWatchSmokeReport["importFiles"];
  scheduledMonitorCheck: OmiWatchSmokeReport["scheduledMonitorCheck"];
  stageTimingsMs: OmiWatchSmokeReport["stageTimingsMs"];
  blockedStage: OmiWatchSmokeReport["blockedStage"];
  blockedStageReason: OmiWatchSmokeReport["blockedStageReason"];
  queries: OmiWatchSmokeReport["queries"];
  graph: OmiWatchSmokeReport["graph"];
  clarifications: OmiWatchSmokeReport["clarifications"];
  productionReadiness: OmiWatchSmokeReport["productionReadiness"];
}

const DEFAULT_NAMESPACE_ID = "omi_sandbox";
const DEFAULT_SOURCE_LABEL = "OMI Watch Smoke";

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function repoRoot(): string {
  return path.resolve(localBrainRoot(), "..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function omiNormalizedRoot(): string {
  const explicitRoot = process.env.BRAIN_OMI_WATCH_ROOT?.trim();
  if (explicitRoot) {
    return explicitRoot;
  }

  if ((process.env.BRAIN_OMI_WATCH_MODE ?? "").trim().toLowerCase() === "full") {
    return path.resolve(repoRoot(), "data/inbox/omi/normalized");
  }

  return omiWatchFixtureRoot();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function confidenceRank(value: Confidence): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function max(values: readonly number[]): number {
  return values.length > 0 ? Number(Math.max(...values).toFixed(2)) : 0;
}

function readNumberRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function countStringValues(values: readonly (string | null | undefined)[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function toMarkdown(report: OmiWatchSmokeReport): string {
  const lines = [
    "# OMI Watch Smoke Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- source: ${report.source.label} (${report.source.id})`,
    `- rootPath: ${report.source.rootPath}`,
    `- passed: ${report.passed}`,
    `- blockedStage: ${report.blockedStage ?? "none"}`,
    `- blockedStageReason: ${report.blockedStageReason ?? "none"}`,
    "",
    "## First Scan",
    "",
    `- supported files: ${report.firstScan.totalFiles}`,
    `- markdown files: ${report.firstScan.markdownFiles}`,
    `- ignored files: ${report.firstScan.ignoredFiles.join(", ") || "none"}`,
    "",
    "## Import",
    "",
    `- status: ${report.importRun.status}`,
    `- attempted/imported/failed: ${report.importRun.filesAttempted}/${report.importRun.filesImported}/${report.importRun.filesFailed}`,
    `- files: ${report.importFiles.length}`,
    "",
    "## Scheduled Monitor Check",
    "",
    `- status: ${report.scheduledMonitorCheck.status}`,
    `- due sources: ${report.scheduledMonitorCheck.dueSourceCount}`,
    `- processed: ${report.scheduledMonitorCheck.processedCount}`,
    `- actions: ${report.scheduledMonitorCheck.actions.join(", ") || "none"}`,
    "",
    "## Stage Timings",
    "",
    "",
    "## Queries",
    ""
  ];

  for (const [stage, duration] of Object.entries(report.stageTimingsMs)) {
    lines.push(`- ${stage}: ${duration}ms`);
  }

  lines.push("", "## Import File Progress", "");
  for (const file of report.importFiles) {
    lines.push(
      `- ${file.relativePath}: ${file.status} attempted/imported/failed=${file.filesAttempted}/${file.filesImported}/${file.filesFailed} durationMs=${file.stageMs}${file.error ? ` error=${file.error}` : ""}`
    );
  }

  for (const query of report.queries) {
    lines.push(
      `- ${query.name}: ${query.passed ? "pass" : "fail"} | confidence=${query.confidence} | latency=${query.latencyMs}ms | route=${query.finalRouteFamily ?? query.dominantStage ?? "none"}`
    );
    for (const failure of query.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("", "## Production Readiness", "");
  lines.push(`- pass rate: ${report.productionReadiness.correctness.omiWatchPassRate}`);
  lines.push(
    `- latency p50/p95/max: ${report.productionReadiness.latency.omiWatchP50Ms}/${report.productionReadiness.latency.omiWatchP95Ms}/${report.productionReadiness.latency.omiWatchMaxMs}ms`
  );
  lines.push(`- direct routes: ${JSON.stringify(report.productionReadiness.routePurity.directRouteSuccessCountByFamily)}`);
  lines.push(`- slow rows missing route owner: ${report.productionReadiness.routePurity.slowRowsMissingRouteOwnerCount}`);

  lines.push("");
  lines.push("## Graph");
  lines.push("");
  lines.push(`- nodes/edges: ${report.graph.nodeCount}/${report.graph.edgeCount}`);
  lines.push(`- highlighted names: ${report.graph.highlightedNames.join(", ") || "none"}`);
  for (const failure of report.graph.failures) {
    lines.push(`  - ${failure}`);
  }
  lines.push("");
  lines.push("## Clarifications");
  lines.push("");
  lines.push(`- total: ${report.clarifications.total}`);
  lines.push(`- byType: ${JSON.stringify(report.clarifications.byType)}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function querySpecs(): readonly OmiWatchQuerySpec[] {
  return [
    {
      name: "omi_meetup_location",
      query: "where was the AI meetup?",
      expectedTerms: ["Canass Hotel", "Chiang Mai"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_meetup_friends",
      query: "who introduced Steve to Tim and Ben?",
      expectedTerms: ["Dan"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_coffee_stop",
      query: "after the AI/LLM meetup at Canass Hotel in Chiang Mai, what coffee place did Steve go to?",
      expectedTerms: ["Living a Dream"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_april_trip",
      query: "what trip is Steve planning for the end of April?",
      expectedTerms: ["Istanbul", "Turkey", "Pilots Association"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_lauren_history",
      query: "what is Steve's history with Lauren?",
      expectedTerms: ["Lauren", "Bend", "Tahoe"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_before_chiang_mai",
      query: "where did Steve live before Chiang Mai?",
      expectedTerms: ["Koh Samui"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_lauren_departure",
      query: "when did Lauren leave for the US?",
      expectedTerms: ["October 18, 2025"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_us_storage",
      query: "where are Steve's things stored in the US?",
      expectedTerms: ["Bend", "Reno", "Carson"],
      minimumConfidence: "weak"
    },
    {
      name: "omi_recent_movies",
      query: "what movies has Steve watched recently?",
      expectedTerms: ["Sinners", "Chainsaw"],
      minimumConfidence: "weak"
    }
  ];
}

async function ensureOmiSource(namespaceId: string) {
  const rootPath = omiNormalizedRoot();
  const existing = (await listMonitoredSources()).find(
    (source) => source.namespaceId === namespaceId && source.rootPath === rootPath
  );

  if (existing) {
    await deleteMonitoredSource(existing.id);
  }

  return createMonitoredSource({
    sourceType: "folder",
    namespaceId,
    label: DEFAULT_SOURCE_LABEL,
    rootPath,
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "Sandbox watched-folder smoke source for OMI normalized transcript imports.",
    metadata: {
      source_intent: "ongoing_folder_monitor",
      producer: "omi_sync",
      smoke_test: true
    }
  });
}

function stageTimeoutMs(): number {
  const raw = Number(process.env.BRAIN_OMI_WATCH_STAGE_TIMEOUT_MS ?? "210000");
  return Number.isFinite(raw) && raw > 0 ? raw : 210000;
}

function createEmptyGraphCheck(): OmiWatchGraphCheck {
  return {
    passed: false,
    failures: [],
    nodeCount: 0,
    edgeCount: 0,
    highlightedNames: []
  };
}

function createEmptyReport(namespaceId: string, rootPath: string): MutableOmiWatchSmokeState {
  return {
    namespaceId,
    source: {
      id: "",
      label: DEFAULT_SOURCE_LABEL,
      rootPath,
      monitorEnabled: true,
      scanSchedule: "every_30_minutes"
    },
    firstScan: {
      totalFiles: 0,
      markdownFiles: 0,
      ignoredFiles: []
    },
    importRun: {
      status: "not_started",
      filesAttempted: 0,
      filesImported: 0,
      filesFailed: 0
    },
    importFiles: [],
    scheduledMonitorCheck: {
      status: "not_started",
      dueSourceCount: 0,
      processedCount: 0,
      actions: []
    },
    stageTimingsMs: {},
    blockedStage: null,
    blockedStageReason: null,
    queries: [],
    graph: createEmptyGraphCheck(),
    clarifications: {
      total: 0,
      byType: {}
    },
    productionReadiness: {
      correctness: {
        omiWatchPassRate: "0/0"
      },
      latency: {
        omiWatchP50Ms: 0,
        omiWatchP95Ms: 0,
        omiWatchMaxMs: 0
      },
      routePurity: {
        directRouteSuccessCountByFamily: {},
        slowRowsMissingRouteOwnerCount: 0
      }
    }
  };
}

async function importOmiWatchFilesSerially(
  report: MutableOmiWatchSmokeState,
  sourceId: string,
  files: readonly { readonly id: string; readonly relativePath: string }[]
): Promise<OmiWatchSmokeReport["importRun"]> {
  const startedAt = performance.now();
  try {
    const result = await importMonitoredSource(
      sourceId,
      "onboarding",
      files.map((file) => file.id),
      {
        forceImport: true,
        skipPostImportRefresh: true,
        skipVectorActivation: true,
        skipRelationIeEnrichment: true
      }
    );
    const filesById = new Map(result.preview.files.map((file) => [file.id, file]));
    const totalStageMs = Number((performance.now() - startedAt).toFixed(2));
    report.importFiles = files.map((file) => {
      const latest = filesById.get(file.id);
      const imported = latest?.lastStatus === "imported";
      const failed = latest?.lastStatus === "error";
      return {
        fileId: file.id,
        relativePath: file.relativePath,
        status: imported ? "succeeded" : failed ? "failed" : latest?.lastStatus ?? result.importRun.status,
        filesAttempted: 1,
        filesImported: imported ? 1 : 0,
        filesFailed: failed ? 1 : 0,
        stageMs: totalStageMs,
        error: latest?.errorMessage ?? null
      };
    });
    return {
      status: result.importRun.status,
      filesAttempted: result.importRun.filesAttempted,
      filesImported: result.importRun.filesImported,
      filesFailed: result.importRun.filesFailed
    };
  } catch (error) {
    const totalStageMs = Number((performance.now() - startedAt).toFixed(2));
    report.importFiles = files.map((file) => ({
      fileId: file.id,
      relativePath: file.relativePath,
      status: "failed",
      filesAttempted: 1,
      filesImported: 0,
      filesFailed: 1,
      stageMs: totalStageMs,
      error: error instanceof Error ? error.message : String(error)
    }));
    throw error;
  }
}

async function measureStage<T>(
  report: MutableOmiWatchSmokeState,
  stage: string,
  fn: () => Promise<T>,
  timeoutMs = stageTimeoutMs()
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`stage ${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    report.stageTimingsMs = {
      ...report.stageTimingsMs,
      [stage]: Number((performance.now() - startedAt).toFixed(2))
    };
    return result;
  } catch (error) {
    report.stageTimingsMs = {
      ...report.stageTimingsMs,
      [stage]: Number((performance.now() - startedAt).toFixed(2))
    };
    report.blockedStage = stage;
    report.blockedStageReason = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
  await runRelationshipAdjudication(namespaceId, {
    limit: 800,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  await runCandidateConsolidation(namespaceId, 800);
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, { layer, lookbackDays: 120 });
  }
  await runTemporalNodeArchival(namespaceId);
  await executeProvenanceAuditWorker();
}

async function runQuery(namespaceId: string, spec: OmiWatchQuerySpec): Promise<OmiWatchQueryResult> {
  const startedAt = performance.now();
  const result = await searchMemory({
    namespaceId,
    query: spec.query,
    limit: 8
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const confidence = (result.meta.answerAssessment?.confidence ?? "missing") as Confidence;
  const meta = result.meta;
  const joined = `${result.duality.claim.text ?? ""}\n${result.results.map((item) => item.content).join("\n")}`.toLowerCase();
  const failures: string[] = [];

  for (const expected of spec.expectedTerms) {
    if (!joined.includes(expected.toLowerCase())) {
      failures.push(`missing term ${expected}`);
    }
  }

  if (confidenceRank(confidence) < confidenceRank(spec.minimumConfidence)) {
    failures.push(`confidence ${confidence} below ${spec.minimumConfidence}`);
  }

  return {
    name: spec.name,
    query: spec.query,
    latencyMs,
    confidence,
    dominantStage: typeof meta.dominantStage === "string" ? meta.dominantStage : null,
    topStageMs: typeof meta.topStageMs === "number" ? meta.topStageMs : null,
    finalRouteFamily: typeof meta.finalRouteFamily === "string" ? meta.finalRouteFamily : null,
    sourceBoundedReadTried: typeof meta.sourceBoundedReadTried === "boolean" ? meta.sourceBoundedReadTried : null,
    sourceBoundedReadSucceeded: typeof meta.sourceBoundedReadSucceeded === "boolean" ? meta.sourceBoundedReadSucceeded : null,
    relationshipFastPathTried: typeof meta.relationshipFastPathTried === "boolean" ? meta.relationshipFastPathTried : null,
    relationshipFastPathSucceeded: typeof meta.relationshipFastPathSucceeded === "boolean" ? meta.relationshipFastPathSucceeded : null,
    candidateCountsByStage: readNumberRecord(meta.candidateCountsByStage),
    rowsScannedByStage: readNumberRecord(meta.rowsScannedByStage),
    earlyStopReason: typeof meta.earlyStopReason === "string" ? meta.earlyStopReason : null,
    fallbackReason: typeof meta.fallbackReason === "string" ? meta.fallbackReason : null,
    passed: failures.length === 0,
    failures
  };
}

async function runGraphCheck(namespaceId: string): Promise<OmiWatchGraphCheck> {
  const graph = await getOpsRelationshipGraph(namespaceId, {
    entityName: "Steve Tietze",
    limit: 24
  });

  const names = graph.nodes.map((node) => node.name);
  const lowerNames = names.map((name) => name.toLowerCase());
  const failures: string[] = [];
  for (const expected of ["Dan", "Tim", "Chiang Mai"]) {
    if (!lowerNames.includes(expected.toLowerCase())) {
      failures.push(`missing graph node ${expected}`);
    }
  }
  if (names.some((name) => /^speaker\s+\d+/iu.test(name))) {
    failures.push("speaker-label leakage reached the graph");
  }

  return {
    passed: failures.length === 0,
    failures,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    highlightedNames: names.filter((name) => ["Steve Tietze", "Dan", "Tim", "Chiang Mai"].includes(name))
  };
}

export async function runOmiWatchSmokeBenchmark(
  namespaceId = DEFAULT_NAMESPACE_ID
): Promise<OmiWatchSmokeReport> {
  return withMaintenanceLock("the OMI watched-folder smoke benchmark", async () => {
    await runMigrations();
    await upsertNamespaceSelfProfile({
      namespaceId,
      canonicalName: "Steve Tietze",
      aliases: ["Steve"],
      note: "Sandbox self anchor for watched-folder smoke validation."
    });

    if (!process.env.BRAIN_OMI_WATCH_ROOT && (process.env.BRAIN_OMI_WATCH_MODE ?? "").trim().toLowerCase() !== "full") {
      await prepareOmiWatchFixtureRoot();
    }

    const report = createEmptyReport(namespaceId, omiNormalizedRoot());

    try {
      const source = await measureStage(report, "source_setup", () => ensureOmiSource(namespaceId));
      report.source = {
        id: source.id,
        label: source.label,
        rootPath: source.rootPath,
        monitorEnabled: source.monitorEnabled,
        scanSchedule: source.scanSchedule
      };

      const firstScan = await measureStage(report, "first_scan", () => scanMonitoredSource(source.id));
      report.firstScan = {
        totalFiles: firstScan.preview.totalFiles,
        markdownFiles: firstScan.preview.markdownFiles,
        ignoredFiles: firstScan.preview.ignoredFiles
      };

      report.importRun = await measureStage(report, "import_run", () =>
        {
          const importFiles = firstScan.files
            .filter((file) => file.existsNow && file.extension === ".md")
            .map((file) => ({ id: file.id, relativePath: file.relativePath }));
          return importOmiWatchFilesSerially(report, source.id, importFiles);
        },
        Math.max(
          stageTimeoutMs(),
          firstScan.files.filter((file) => file.existsNow && file.extension === ".md").length * stageTimeoutMs() + 30_000
        )
      );

      await measureStage(report, "rebuild_namespace", () => rebuildNamespace(namespaceId));

      const scheduled = await measureStage(report, "scheduled_monitor", () =>
        processScheduledMonitoredSources({
          sourceId: source.id,
          now: new Date(Date.now() + 31 * 60 * 1000),
          importAfterScan: true
        })
      );
      report.scheduledMonitorCheck = {
        status: "completed",
        dueSourceCount: scheduled.dueSourceCount,
        processedCount: scheduled.processedCount,
        actions: scheduled.results.map((item) => item.action)
      };

      const queries: OmiWatchQueryResult[] = [];
      for (const spec of querySpecs()) {
        queries.push(await measureStage(report, `query:${spec.name}`, () => runQuery(namespaceId, spec)));
      }
      report.queries = queries;

      report.graph = await measureStage(report, "graph_check", () => runGraphCheck(namespaceId));
      const clarifications = await measureStage(report, "clarification_audit", () => getOpsClarificationInbox(namespaceId, 20));
      report.clarifications = {
        total: clarifications.summary.total,
        byType: clarifications.summary.byType
      };
    } catch {
      report.scheduledMonitorCheck = {
        ...report.scheduledMonitorCheck,
        status: report.scheduledMonitorCheck.status === "not_started" ? "blocked" : report.scheduledMonitorCheck.status
      };
    }

    const queryLatencies = report.queries.map((query) => query.latencyMs);
    const productionReadiness: OmiWatchSmokeReport["productionReadiness"] = {
      correctness: {
        omiWatchPassRate: `${report.queries.filter((item) => item.passed).length}/${querySpecs().length}`
      },
      latency: {
        omiWatchP50Ms: percentile(queryLatencies, 50),
        omiWatchP95Ms: percentile(queryLatencies, 95),
        omiWatchMaxMs: max(queryLatencies)
      },
      routePurity: {
        directRouteSuccessCountByFamily: countStringValues(
          report.queries
            .filter((query) => query.passed && query.sourceBoundedReadSucceeded === true)
            .map((query) => query.finalRouteFamily ?? query.dominantStage)
        ),
        slowRowsMissingRouteOwnerCount: report.queries.filter(
          (query) => query.latencyMs > 5000 && !query.finalRouteFamily && !query.dominantStage
        ).length
      }
    };
    return {
      ...report,
      productionReadiness,
      generatedAt: new Date().toISOString(),
      passed:
        report.blockedStage === null &&
        report.firstScan.totalFiles >= 3 &&
        report.firstScan.ignoredFiles.some((entry) => entry.includes(".DS_Store")) &&
        report.importRun.filesImported >= 3 &&
        report.scheduledMonitorCheck.processedCount >= 1 &&
        report.queries.length === querySpecs().length &&
        report.queries.every((item) => item.passed) &&
        report.graph.passed &&
        productionReadiness.latency.omiWatchP95Ms <= 10000 &&
        productionReadiness.latency.omiWatchMaxMs <= 20000 &&
        productionReadiness.routePurity.slowRowsMissingRouteOwnerCount === 0
    };
  });
}

export async function runAndWriteOmiWatchSmokeBenchmark(): Promise<{
  readonly report: OmiWatchSmokeReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runOmiWatchSmokeBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `omi-watch-smoke-${stamp}.json`);
    const markdownPath = path.join(dir, `omi-watch-smoke-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  } finally {
    await closePool();
  }
}

export async function runOmiWatchSmokeBenchmarkCli(): Promise<void> {
  const result = await runAndWriteOmiWatchSmokeBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
