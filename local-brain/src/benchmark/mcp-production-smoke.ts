import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { upsertNamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalNodeArchival, runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { executeMcpTool } from "../mcp/server.js";
import { executeProvenanceAuditWorker } from "../ops/runtime-worker-service.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  importMonitoredSource,
  listMonitoredSources,
  scanMonitoredSource
} from "../ops/source-service.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import type { ProductionFailureCategory } from "./production-confidence-shared.js";
import { countFailureCategories } from "./production-confidence-shared.js";

type Confidence = "confident" | "weak" | "missing";
type ToolName =
  | "memory.recap"
  | "memory.extract_tasks"
  | "memory.extract_calendar"
  | "memory.explain_recap"
  | "memory.search"
  | "memory.get_relationships"
  | "memory.get_graph"
  | "memory.get_clarifications";

interface Scenario {
  readonly name: string;
  readonly tool: ToolName;
  readonly namespaceId: string;
  readonly args: Record<string, unknown>;
  readonly expectedTerms: readonly string[];
  readonly minimumConfidence?: Confidence;
  readonly minimumEvidence?: number;
  readonly requireSourceLink?: boolean;
  readonly allowMissingEvidence?: boolean;
  readonly failureCategoriesOnFail: readonly ProductionFailureCategory[];
}

interface ScenarioResult {
  readonly name: string;
  readonly tool: ToolName;
  readonly namespaceId: string;
  readonly confidence: string | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly passed: boolean;
  readonly primaryFailureCategory: ProductionFailureCategory | null;
  readonly failureCategories: readonly ProductionFailureCategory[];
  readonly failures: readonly string[];
}

export interface McpProductionSmokeReport {
  readonly generatedAt: string;
  readonly results: readonly ScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly failureCategoryCounts: Record<ProductionFailureCategory, number>;
  };
  readonly passed: boolean;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function continuityFixtureRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "personal-openclaw-fixtures");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null).toLowerCase();
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).includes(term.toLowerCase());
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  if (Array.isArray(payload?.relationships)) {
    return payload.relationships;
  }
  if (Array.isArray(payload?.graph?.edges)) {
    return payload.graph.edges;
  }
  if (Array.isArray(payload?.edges)) {
    return payload.edges;
  }
  return [];
}

function sourceLinkCount(items: readonly any[]): number {
  let count = 0;
  for (const item of items) {
    if (typeof item?.artifactId === "string" && item.artifactId) {
      count += 1;
      continue;
    }
    if (typeof item?.sourceUri === "string" && item.sourceUri) {
      count += 1;
      continue;
    }
    if (typeof item?.provenance?.source_uri === "string" && item.provenance.source_uri) {
      count += 1;
    }
  }
  return count;
}

function confidenceRank(value: string | null): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

async function ensureContinuityShadowSource(namespaceId: string) {
  const existing = (await listMonitoredSources(100)).filter((source) => source.namespaceId === namespaceId);
  for (const source of existing) {
    await deleteMonitoredSource(source.id);
  }
  return createMonitoredSource({
    sourceType: "openclaw",
    namespaceId,
    label: "Personal OpenClaw Continuity Shadow",
    rootPath: continuityFixtureRoot(),
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "Synthetic OpenClaw-style markdown corpus for production smoke continuity benchmarking.",
    metadata: {
      source_intent: "continuity_shadow_smoke",
      producer: "mcp_production_smoke_benchmark",
      fixture_family: "openclaw_markdown"
    }
  });
}

async function rebuildContinuityShadowNamespace(namespaceId: string): Promise<void> {
  await runCandidateConsolidation(namespaceId, 800);
  await runRelationshipAdjudication(namespaceId, {
    limit: 800,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, { layer, lookbackDays: 60 });
  }
  await runTemporalNodeArchival(namespaceId);
  await executeProvenanceAuditWorker();
  await rebuildTypedMemoryNamespace(namespaceId);
}

async function primeContinuityShadowNamespace(namespaceId = "personal_continuity_shadow"): Promise<void> {
  await runMigrations();
  await upsertNamespaceSelfProfile({
    namespaceId,
    canonicalName: "Steve Tietze",
    aliases: ["Steve"],
    note: "Shadow self anchor for production-smoke continuity benchmarking."
  });
  const source = await ensureContinuityShadowSource(namespaceId);
  await scanMonitoredSource(source.id);
  await importMonitoredSource(source.id, "onboarding");
  await rebuildContinuityShadowNamespace(namespaceId);
}

function scenarios(): readonly Scenario[] {
  return [
    {
      name: "continuity_yesterday_pack",
      tool: "memory.recap",
      namespaceId: "personal_continuity_shadow",
      args: {
        namespace_id: "personal_continuity_shadow",
        query: "Give me a recap of what I was talking about yesterday, including projects and people.",
        reference_now: "2026-03-28T08:00:00Z",
        limit: 8
      },
      expectedTerms: ["preset kitchen", "dan"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error"]
    },
    {
      name: "continuity_support_file",
      tool: "memory.explain_recap",
      namespaceId: "personal_continuity_shadow",
      args: {
        namespace_id: "personal_continuity_shadow",
        query: "Why do you think the 2026-03-27 memory note is the right evidence for what I was talking about yesterday?",
        reference_now: "2026-03-28T08:00:00Z",
        limit: 8
      },
      expectedTerms: ["2026-03-27", "memory"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error", "weak_provenance"]
    },
    {
      name: "entity_dan_relationship",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "Who is Dan in my life right now, exactly?",
        limit: 8
      },
      expectedTerms: ["friend", "chiang mai"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error"]
    },
    {
      name: "relationships_dan_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Dan",
        limit: 8
      },
      expectedTerms: ["friend_of", "steve", "chiang mai"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "relationships_lauren_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Lauren",
        limit: 8
      },
      expectedTerms: ["former_partner_of", "steve"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "relationships_lauren_history_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Lauren",
        include_historical: true,
        limit: 12
      },
      expectedTerms: ["former_partner_of", "steve", "validuntil"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["temporal_resolution_error", "weak_provenance"]
    },
    {
      name: "entity_lauren_current_relationship",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "Who is Lauren in my life right now, exactly?",
        limit: 8
      },
      expectedTerms: ["former partner", "lauren"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "temporal_resolution_error", "weak_provenance"]
    },
    {
      name: "habits_constraints_current",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What habits or constraints matter right now?",
        limit: 8
      },
      expectedTerms: ["coffee", "reddit", "personal time"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error", "weak_provenance"]
    },
    {
      name: "relationships_john_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "John",
        limit: 8
      },
      expectedTerms: ["owner_of", "samui experience", "koh samui"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "alias_uncle_resolution",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "Who is Uncle?",
        limit: 8
      },
      expectedTerms: ["billy smith", "joe bob"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "clarifications_uncle_closed",
      tool: "memory.get_clarifications",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "uncle",
        limit: 8
      },
      expectedTerms: ["no open clarification items matched", "uncle"],
      allowMissingEvidence: true,
      failureCategoriesOnFail: ["clarification_closure_error"]
    },
    {
      name: "relationships_james_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "James",
        limit: 8
      },
      expectedTerms: ["friend_of", "steve", "lake tahoe"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "temporal_lauren_departure",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "When did Lauren leave for the US?",
        limit: 8
      },
      expectedTerms: ["october 18", "2025"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["temporal_resolution_error"]
    },
    {
      name: "entity_dan_movie_two_weeks",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What movie did Dan mention two weeks ago, and where did he mention it?",
        limit: 8
      },
      expectedTerms: ["sinners", "13 march 2026", "korean barbecue place"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "temporal_resolution_error"]
    },
    {
      name: "project_ben_idea_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What project idea did Ben and I discuss, and what was the idea exactly?",
        limit: 8
      },
      expectedTerms: ["context suite", "memoir engine", "chapters of a person's memoir"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "yesterday_work_recap",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What did I do yesterday?",
        limit: 8
      },
      expectedTerms: ["ai brain", "preset kitchen", "bumblebee", "yesterday"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error", "weak_provenance"]
    },
    {
      name: "yesterday_talk_recap",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What did I talk about yesterday?",
        limit: 8
      },
      expectedTerms: ["ai brain", "preset kitchen", "bumblebee", "two way"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error", "weak_provenance"]
    },
    {
      name: "warm_start_today",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What should you know about me to start today?",
        limit: 8
      },
      expectedTerms: ["warm start for steve", "current focus", "well inked", "two way", "preset kitchen", "ai brain"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["continuity_pack_error", "weak_provenance"]
    },
    {
      name: "purchase_today_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What did I buy on March 28, 2026 and what were the prices?",
        limit: 8
      },
      expectedTerms: ["snickers bar", "toilet paper", "780 baht", "24 usd"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["weak_provenance"]
    },
    {
      name: "media_titles_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What movies have I talked about?",
        limit: 8
      },
      expectedTerms: ["sinners", "slow horses", "avatar"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["weak_provenance"]
    },
    {
      name: "food_preference_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What food did I like?",
        limit: 8
      },
      expectedTerms: ["spicy food", "nachos"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["missing_evidence", "weak_provenance"]
    },
    {
      name: "beer_preference_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What are my favorite beers in Thailand?",
        limit: 8
      },
      expectedTerms: ["leo", "singha", "chang", "in that order"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["missing_evidence", "weak_provenance"]
    },
    {
      name: "preferences_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What do I like and dislike?",
        limit: 8
      },
      expectedTerms: ["macbook pros", "snowboarding", "windows machines", "android phones", "mushy vegetables", "spicy food"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["weak_provenance", "missing_evidence"]
    },
    {
      name: "routine_current_exact",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What is my current daily routine?",
        limit: 8
      },
      expectedTerms: ["wake around 7 to 8 am", "make coffee", "reddit", "start work around 10 am", "midday exercise break"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["weak_provenance", "missing_evidence"]
    },
    {
      name: "lauren_change_direct",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What changed with Lauren, and when?",
        limit: 8
      },
      expectedTerms: ["lauren", "october 18, 2025", "stopped talking"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["temporal_resolution_error", "weak_provenance"]
    },
    {
      name: "lauren_stop_talking_when",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "When did Steve and Lauren stop talking?",
        limit: 8
      },
      expectedTerms: ["lauren", "october 18, 2025", "stopped talking"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["temporal_resolution_error", "weak_provenance"]
    },
    {
      name: "relationship_transition_startup",
      tool: "memory.search",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        query: "What important relationship transition should I know about right now?",
        limit: 8
      },
      expectedTerms: ["lauren", "october 18, 2025", "stopped talking"],
      minimumConfidence: "confident",
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["temporal_resolution_error", "weak_provenance"]
    },
    {
      name: "relationships_ben_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Ben",
        limit: 8
      },
      expectedTerms: ["ben", "friend_of", "well inked"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "relationships_omi_direct",
      tool: "memory.get_relationships",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Omi",
        limit: 8
      },
      expectedTerms: ["omi", "owner_of", "two way"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "task_open_items",
      tool: "memory.extract_tasks",
      namespaceId: "personal_continuity_shadow",
      args: {
        namespace_id: "personal_continuity_shadow",
        query: "Make a task list from what was still open in my recent notes yesterday and before context was lost.",
        reference_now: "2026-03-28T08:00:00Z",
        limit: 8
      },
      expectedTerms: ["continuity benchmark", "review open tasks"],
      minimumEvidence: 1,
      requireSourceLink: true,
      failureCategoriesOnFail: ["task_extraction_error"]
    },
    {
      name: "graph_dan_neighborhood",
      tool: "memory.get_graph",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Dan",
        limit: 40
      },
      expectedTerms: ["Dan", "Chiang Mai"],
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "graph_john_neighborhood",
      tool: "memory.get_graph",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "John",
        limit: 40
      },
      expectedTerms: ["John", "Samui Experience", "Koh Samui"],
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance"]
    },
    {
      name: "graph_kozimui_alias",
      tool: "memory.get_graph",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Kozimui",
        limit: 40
      },
      expectedTerms: ["Koh Samui", "requestedentity", "kozimui"],
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance", "atlas_truth_error"]
    },
    {
      name: "graph_lauren_history_window",
      tool: "memory.get_graph",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Lauren",
        time_start: "2024-01-01T00:00:00Z",
        time_end: "2026-12-31T23:59:59Z",
        limit: 40
      },
      expectedTerms: ["Lauren", "former_partner_of", "validuntil"],
      failureCategoriesOnFail: ["temporal_resolution_error", "atlas_truth_error"]
    },
    {
      name: "graph_omi_neighborhood",
      tool: "memory.get_graph",
      namespaceId: "personal",
      args: {
        namespace_id: "personal",
        entity_name: "Omi",
        limit: 40
      },
      expectedTerms: ["Omi", "Two Way"],
      failureCategoriesOnFail: ["entity_resolution_error", "weak_provenance", "atlas_truth_error"]
    }
  ];
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const wrapped = (await executeMcpTool(scenario.tool, scenario.args)) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const evidence = evidenceItems(payload);
  const confidence =
    typeof payload?.duality?.confidence === "string"
      ? payload.duality.confidence
      : typeof payload?.confidence === "string"
        ? payload.confidence
        : null;
  const failures: string[] = [];

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(payload, term)) {
      failures.push(`missing term ${term}`);
    }
  }
  if (scenario.minimumConfidence && confidenceRank(confidence) < confidenceRank(scenario.minimumConfidence)) {
    failures.push(`confidence ${confidence ?? "missing"} below ${scenario.minimumConfidence}`);
  }
  if ((scenario.minimumEvidence ?? 0) > evidence.length) {
    failures.push(`expected at least ${scenario.minimumEvidence} evidence rows, got ${evidence.length}`);
  }
  if (!scenario.allowMissingEvidence && evidence.length === 0 && (scenario.minimumEvidence ?? 0) === 0) {
    failures.push("no evidence returned");
  }
  if (scenario.requireSourceLink && sourceLinkCount(evidence) === 0) {
    failures.push("expected at least one source-linked evidence row");
  }

  return {
    name: scenario.name,
    tool: scenario.tool,
    namespaceId: scenario.namespaceId,
    confidence,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    passed: failures.length === 0,
    primaryFailureCategory: failures.length === 0 ? null : scenario.failureCategoriesOnFail[0] ?? null,
    failureCategories: failures.length === 0 ? [] : [...scenario.failureCategoriesOnFail],
    failures
  };
}

function toMarkdown(report: McpProductionSmokeReport): string {
  const lines = [
    "# MCP Production Smoke",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- pass/fail: ${report.summary.pass}/${report.summary.fail}`,
    `- passed: ${report.passed}`,
    `- failureCategoryCounts: ${JSON.stringify(report.summary.failureCategoryCounts)}`,
    "",
    "## Results",
    ""
  ];
  for (const result of report.results) {
    lines.push(
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | tool=${result.tool} | confidence=${result.confidence ?? "missing"} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount}`
    );
    if (result.failureCategories.length > 0) {
      lines.push(`  - failureCategories: ${result.failureCategories.join(", ")}`);
    }
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMcpProductionSmokeBenchmark(): Promise<{
  readonly report: McpProductionSmokeReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  return withMaintenanceLock("the MCP production smoke benchmark", async () => {
    await primeContinuityShadowNamespace();

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios()) {
      results.push(await runScenario(scenario));
    }
    const report: McpProductionSmokeReport = {
      generatedAt: new Date().toISOString(),
      results,
      summary: {
        pass: results.filter((item) => item.passed).length,
        fail: results.filter((item) => !item.passed).length,
        failureCategoryCounts: countFailureCategories(results)
      },
      passed: results.every((item) => item.passed)
    };
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `mcp-production-smoke-${stamp}.json`);
    const markdownPath = path.join(dir, `mcp-production-smoke-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  });
}

export async function runMcpProductionSmokeBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteMcpProductionSmokeBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
