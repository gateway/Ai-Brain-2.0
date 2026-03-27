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
  readonly scheduledMonitorCheck: {
    readonly dueSourceCount: number;
    readonly processedCount: number;
    readonly actions: readonly string[];
  };
  readonly queries: readonly OmiWatchQueryResult[];
  readonly graph: OmiWatchGraphCheck;
  readonly clarifications: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly passed: boolean;
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
  return path.resolve(repoRoot(), "data/inbox/omi/normalized");
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

function toMarkdown(report: OmiWatchSmokeReport): string {
  const lines = [
    "# OMI Watch Smoke Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- source: ${report.source.label} (${report.source.id})`,
    `- rootPath: ${report.source.rootPath}`,
    `- passed: ${report.passed}`,
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
    "",
    "## Scheduled Monitor Check",
    "",
    `- due sources: ${report.scheduledMonitorCheck.dueSourceCount}`,
    `- processed: ${report.scheduledMonitorCheck.processedCount}`,
    `- actions: ${report.scheduledMonitorCheck.actions.join(", ") || "none"}`,
    "",
    "## Queries",
    ""
  ];

  for (const query of report.queries) {
    lines.push(`- ${query.name}: ${query.passed ? "pass" : "fail"} | confidence=${query.confidence} | latency=${query.latencyMs}ms`);
    for (const failure of query.failures) {
      lines.push(`  - ${failure}`);
    }
  }

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

    const source = await ensureOmiSource(namespaceId);
    const firstScan = await scanMonitoredSource(source.id);
    const importResult = await importMonitoredSource(source.id, "onboarding");
    await rebuildNamespace(namespaceId);

    const scheduled = await processScheduledMonitoredSources({
      sourceId: source.id,
      now: new Date(Date.now() + 31 * 60 * 1000),
      importAfterScan: true
    });

    const queries: OmiWatchQueryResult[] = [];
    for (const spec of querySpecs()) {
      queries.push(await runQuery(namespaceId, spec));
    }

    const graph = await runGraphCheck(namespaceId);
    const clarifications = await getOpsClarificationInbox(namespaceId, 20);

    return {
      generatedAt: new Date().toISOString(),
      namespaceId,
      source: {
        id: source.id,
        label: source.label,
        rootPath: source.rootPath,
        monitorEnabled: source.monitorEnabled,
        scanSchedule: source.scanSchedule
      },
      firstScan: {
        totalFiles: firstScan.preview.totalFiles,
        markdownFiles: firstScan.preview.markdownFiles,
        ignoredFiles: firstScan.preview.ignoredFiles
      },
      importRun: {
        status: importResult.importRun?.status ?? "unknown",
        filesAttempted: importResult.importRun?.filesAttempted ?? 0,
        filesImported: importResult.importRun?.filesImported ?? 0,
        filesFailed: importResult.importRun?.filesFailed ?? 0
      },
      scheduledMonitorCheck: {
        dueSourceCount: scheduled.dueSourceCount,
        processedCount: scheduled.processedCount,
        actions: scheduled.results.map((item) => item.action)
      },
      queries,
      graph,
      clarifications: {
        total: clarifications.summary.total,
        byType: clarifications.summary.byType
      },
      passed:
        firstScan.preview.totalFiles >= 3 &&
        firstScan.preview.ignoredFiles.some((entry) => entry.includes(".DS_Store")) &&
        (importResult.importRun?.filesImported ?? 0) >= 3 &&
        scheduled.processedCount >= 1 &&
        queries.every((item) => item.passed) &&
        graph.passed
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
