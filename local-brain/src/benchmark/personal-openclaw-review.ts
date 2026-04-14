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
import { executeMcpTool } from "../mcp/server.js";
import { executeProvenanceAuditWorker } from "../ops/runtime-worker-service.js";
import {
  createMonitoredSource,
  deleteMonitoredSource,
  importMonitoredSource,
  listMonitoredSourceFiles,
  listMonitoredSources,
  scanMonitoredSource
} from "../ops/source-service.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import type { ProductionFailureCategory } from "./production-confidence-shared.js";
import { countFailureCategories } from "./production-confidence-shared.js";

type ReviewTool = "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar" | "memory.explain_recap";
type Confidence = "confident" | "weak" | "missing";
type ReviewStatus = "pass" | "fail";

interface SourceShapeCheck {
  readonly relativePath: string;
  readonly expectedKind: "daily" | "long_term" | "bootstrap" | "workspace_note";
  readonly expectedSessionDate?: string;
  readonly expectedBootstrapFile?: string;
  readonly optional?: boolean;
}

interface ContinuityScenario {
  readonly name: string;
  readonly tool: ReviewTool;
  readonly prompt: string;
  readonly toolQuery?: string;
  readonly referenceNow: string;
  readonly expectedTerms: readonly string[];
  readonly minimumConfidence: Confidence;
  readonly minimumEvidence: number;
  readonly maximumPackSize: number;
  readonly minimumTaskCount?: number;
  readonly minimumCalendarCount?: number;
  readonly expectedSourcePathTerms?: readonly string[];
}

interface ContinuityScenarioResult {
  readonly name: string;
  readonly tool: ReviewTool;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: string | null;
  readonly sufficiency: string | null;
  readonly subjectMatch: string | null;
  readonly continuityPackSize: number;
  readonly continuityEvidenceCount: number;
  readonly continuitySourceLinkCount: number;
  readonly continuityTaskCount: number;
  readonly continuityCalendarCount: number;
  readonly continuityClarificationSuggested: boolean;
  readonly dominantStage: string | null;
  readonly topStageMs: number | null;
  readonly leafTraversalTriggered: boolean;
  readonly descentTriggered: boolean;
  readonly descentStages: readonly string[];
  readonly reducerFamily: string | null;
  readonly finalClaimSource: string | null;
  readonly fallbackSuppressedReason: string | null;
  readonly stageTimingsMs: Readonly<Record<string, number>> | null;
  readonly summaryText: string | null;
  readonly sourcePaths: readonly string[];
  readonly status: ReviewStatus;
  readonly primaryFailureCategory: ProductionFailureCategory | null;
  readonly failureCategories: readonly ProductionFailureCategory[];
  readonly failures: readonly string[];
}

export interface PersonalOpenClawReviewReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly fixtureRoot: string;
  readonly source: {
    readonly id: string;
    readonly label: string;
    readonly rootPath: string;
    readonly filesImported: number;
  };
  readonly sourceShape: {
    readonly passed: boolean;
    readonly filesChecked: number;
    readonly failures: readonly string[];
  };
  readonly scenarios: readonly ContinuityScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly answerableContinuityQuestions: number;
    readonly continuityMissingEvidence: number;
    readonly continuityWrongClaimWithGoodEvidence: number;
    readonly failureCategoryCounts: Record<ProductionFailureCategory, number>;
  };
}

const DEFAULT_NAMESPACE_ID = "personal_continuity_shadow";

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function fixtureRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "personal-openclaw-fixtures");
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  return [];
}

function sourcePathsFromPayload(payload: any): readonly string[] {
  return [
    ...new Set(
      evidenceItems(payload)
        .map((item: any) => (typeof item?.sourceUri === "string" ? item.sourceUri : null))
        .filter((item: string | null): item is string => Boolean(item))
    )
  ];
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
    }
  }
  return count;
}

function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
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

function summarizeTasks(payload: any): string | null {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  if (tasks.length === 0) {
    return null;
  }
  return tasks
    .slice(0, 5)
    .map((task: any) => {
      const title = typeof task?.title === "string" ? task.title : "untitled task";
      const project = typeof task?.project === "string" && task.project ? ` [${task.project}]` : "";
      return `- ${title}${project}`;
    })
    .join("\n");
}

function summarizeCalendar(payload: any): string | null {
  const commitments = Array.isArray(payload?.commitments) ? payload.commitments : [];
  if (commitments.length === 0) {
    return null;
  }
  return commitments
    .slice(0, 5)
    .map((commitment: any) => {
      const title = typeof commitment?.title === "string" ? commitment.title : "untitled commitment";
      const time = typeof commitment?.timeHint === "string" && commitment.timeHint ? ` at ${commitment.timeHint}` : "";
      const location = typeof commitment?.locationHint === "string" && commitment.locationHint ? ` in ${commitment.locationHint}` : "";
      return `- ${title}${time}${location}`;
    })
    .join("\n");
}

function continuitySummary(payload: any, tool: ReviewTool): string | null {
  if (tool === "memory.extract_tasks") {
    return summarizeTasks(payload);
  }
  if (tool === "memory.extract_calendar") {
    return summarizeCalendar(payload);
  }
  if (typeof payload?.summaryText === "string" && payload.summaryText.trim()) {
    return payload.summaryText.trim();
  }
  if (typeof payload?.claimText === "string" && payload.claimText.trim()) {
    return payload.claimText.trim();
  }
  if (typeof payload?.explanation === "string" && payload.explanation.trim()) {
    return payload.explanation.trim();
  }
  return null;
}

function stageTimingsFromPayload(payload: any): Readonly<Record<string, number>> | null {
  if (!payload?.meta?.stageTimingsMs || typeof payload.meta.stageTimingsMs !== "object") {
    return null;
  }
  const timings: Record<string, number> = {};
  for (const [key, value] of Object.entries(payload.meta.stageTimingsMs)) {
    if (typeof key === "string" && typeof value === "number") {
      timings[key] = value;
    }
  }
  return timings;
}

function sourceShapeChecks(): readonly SourceShapeCheck[] {
  return [
    {
      relativePath: "memory/2026-03-13.md",
      expectedKind: "daily",
      expectedSessionDate: "2026-03-13"
    },
    {
      relativePath: "memory/2026-03-21.md",
      expectedKind: "daily",
      expectedSessionDate: "2026-03-21"
    },
    {
      relativePath: "memory/2026-03-26.md",
      expectedKind: "daily",
      expectedSessionDate: "2026-03-26"
    },
    {
      relativePath: "memory/2026-03-27.md",
      expectedKind: "daily",
      expectedSessionDate: "2026-03-27"
    },
    {
      relativePath: "MEMORY.md",
      expectedKind: "long_term"
    },
    {
      relativePath: "memory.md",
      expectedKind: "long_term",
      optional: true
    },
    {
      relativePath: "AGENTS.md",
      expectedKind: "bootstrap",
      expectedBootstrapFile: "AGENTS.md"
    },
    {
      relativePath: "TOOLS.md",
      expectedKind: "bootstrap",
      expectedBootstrapFile: "TOOLS.md"
    }
  ];
}

function scenarios(namespaceId: string): readonly ContinuityScenario[] {
  return [
    {
      name: "yesterday_recap",
      tool: "memory.recap",
      prompt: "What was I talking about yesterday?",
      toolQuery: "Give me a recap of what I was talking about yesterday, including projects and people.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["preset kitchen", "continuity", "dan"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 900,
      expectedSourcePathTerms: ["memory/2026-03-27.md"]
    },
    {
      name: "two_weeks_ago_recap",
      tool: "memory.recap",
      prompt: "Summarize everything I said two weeks ago.",
      toolQuery: "Give me a recap of what I wrote two weeks ago, including relationship anchors and people.",
      referenceNow: "2026-03-27T12:00:00Z",
      expectedTerms: ["relationship anchors", "john", "burning man"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 950,
      expectedSourcePathTerms: ["memory/2026-03-13.md"]
    },
    {
      name: "context_lost_recap",
      tool: "memory.recap",
      prompt: "What were we working on before context was lost?",
      toolQuery: "Give me a recap of what we were working on before context was lost.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["fixture corpus", "personal_continuity_shadow", "startup recap pack"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 950
    },
    {
      name: "open_tasks",
      tool: "memory.extract_tasks",
      prompt: "What tasks were still open?",
      toolQuery: "Make a task list from what was still open in my recent notes yesterday and before context was lost.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["re-run the continuity benchmark", "review open tasks"],
      minimumConfidence: "missing",
      minimumEvidence: 1,
      maximumPackSize: 800,
      minimumTaskCount: 2
    },
    {
      name: "upcoming_commitments",
      tool: "memory.extract_calendar",
      prompt: "What calendar items were still coming up?",
      toolQuery: "Pull calendar items that were still coming up from my recent notes.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["breakfast with dan", "grazie"],
      minimumConfidence: "missing",
      minimumEvidence: 1,
      maximumPackSize: 600,
      minimumCalendarCount: 1
    },
    {
      name: "pick_back_up_this_morning",
      tool: "memory.recap",
      prompt: "What should I pick back up this morning?",
      toolQuery: "Give me a recap of what I should pick back up this morning based on what I was doing yesterday.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["preset kitchen", "continuity benchmark"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 850
    },
    {
      name: "completed_last_week_tasks",
      tool: "memory.extract_tasks",
      prompt: "What tasks did I complete last week?",
      toolQuery: "Extract the tasks I completed last week with project hints and evidence.",
      referenceNow: "2026-03-27T12:00:00Z",
      expectedTerms: ["continuity benchmark", "startup recap summary", "fixture corpus"],
      minimumConfidence: "missing",
      minimumEvidence: 1,
      maximumPackSize: 850,
      minimumTaskCount: 3,
      expectedSourcePathTerms: ["memory/2026-03-21.md"]
    },
    {
      name: "changed_since_last_time",
      tool: "memory.recap",
      prompt: "What changed since last time?",
      toolQuery: "Give me a recap of what changed since last time in my recent notes.",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["stopped chasing", "continuity-first evaluation"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 900
    },
    {
      name: "explain_recap_provenance",
      tool: "memory.explain_recap",
      prompt: "What note or file supports that answer?",
      toolQuery: "Why do you think the 2026-03-27 memory note is the right evidence for what I was talking about yesterday?",
      referenceNow: "2026-03-28T08:00:00Z",
      expectedTerms: ["2026-03-27", "memory"],
      minimumConfidence: "weak",
      minimumEvidence: 1,
      maximumPackSize: 900,
      expectedSourcePathTerms: ["memory/2026-03-27.md"]
    }
  ].map((scenario) => ({
    ...scenario,
    namespaceId
  })) as readonly ContinuityScenario[];
}

async function ensureSource(namespaceId: string) {
  const existing = (await listMonitoredSources(100)).filter((source) => source.namespaceId === namespaceId);
  for (const source of existing) {
    await deleteMonitoredSource(source.id);
  }
  return createMonitoredSource({
    sourceType: "openclaw",
    namespaceId,
    label: "Personal OpenClaw Continuity Shadow",
    rootPath: fixtureRoot(),
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "Synthetic OpenClaw-style markdown corpus for continuity benchmarking.",
    metadata: {
      source_intent: "continuity_shadow_eval",
      producer: "personal_openclaw_review_benchmark",
      fixture_family: "openclaw_markdown"
    }
  });
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
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

async function verifySourceShape(sourceId: string): Promise<{
  readonly passed: boolean;
  readonly filesChecked: number;
  readonly failures: readonly string[];
}> {
  const files = await listMonitoredSourceFiles(sourceId, 100);
  const fileByPath = new Map(files.map((file) => [file.relativePath.replace(/\\/gu, "/"), file]));
  const failures: string[] = [];
  const optionalLongTermMemorySeen = sourceShapeChecks()
    .filter((item) => item.expectedKind === "long_term")
    .some((item) => fileByPath.has(item.relativePath));

  for (const check of sourceShapeChecks()) {
    const file = fileByPath.get(check.relativePath);
    if (!file) {
      if (!check.optional) {
        failures.push(`missing scanned file ${check.relativePath}`);
      }
      continue;
    }

    if (file.metadata.openclaw_memory_kind !== check.expectedKind) {
      failures.push(
        `file ${check.relativePath} expected openclaw_memory_kind=${check.expectedKind}, got ${String(file.metadata.openclaw_memory_kind)}`
      );
    }

    if (check.expectedSessionDate && file.metadata.openclaw_session_date !== check.expectedSessionDate) {
      failures.push(
        `file ${check.relativePath} expected openclaw_session_date=${check.expectedSessionDate}, got ${String(file.metadata.openclaw_session_date)}`
      );
    }

    if (check.expectedBootstrapFile && file.metadata.openclaw_bootstrap_file !== check.expectedBootstrapFile) {
      failures.push(
        `file ${check.relativePath} expected openclaw_bootstrap_file=${check.expectedBootstrapFile}, got ${String(file.metadata.openclaw_bootstrap_file)}`
      );
    }
  }

  if (!optionalLongTermMemorySeen) {
    failures.push("expected at least one long-term memory root file (MEMORY.md or memory.md)");
  }

  return {
    passed: failures.length === 0,
    filesChecked: sourceShapeChecks().length,
    failures
  };
}

async function runScenario(namespaceId: string, scenario: ContinuityScenario): Promise<ContinuityScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(scenario.tool, {
    namespace_id: namespaceId,
    query: scenario.toolQuery ?? scenario.prompt,
    reference_now: scenario.referenceNow,
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const evidence = evidenceItems(payload);
  const sourcePaths = sourcePathsFromPayload(payload);
  const summaryText = continuitySummary(payload, scenario.tool);
  const confidence = typeof payload?.confidence === "string" ? payload.confidence : null;
  const sufficiency = typeof payload?.meta?.answerAssessment?.sufficiency === "string" ? payload.meta.answerAssessment.sufficiency : null;
  const subjectMatch = typeof payload?.meta?.answerAssessment?.subjectMatch === "string" ? payload.meta.answerAssessment.subjectMatch : null;
  const taskCount = Array.isArray(payload?.tasks) ? payload.tasks.length : 0;
  const calendarCount = Array.isArray(payload?.commitments) ? payload.commitments.length : 0;
  const failures: string[] = [];

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(payload, term) && !hasTerm(summaryText, term)) {
      failures.push(`missing term ${term}`);
    }
  }

  if (confidenceRank(confidence) < confidenceRank(scenario.minimumConfidence)) {
    failures.push(`confidence ${confidence ?? "missing"} below ${scenario.minimumConfidence}`);
  }

  if (evidence.length < scenario.minimumEvidence) {
    failures.push(`expected at least ${scenario.minimumEvidence} evidence rows, got ${evidence.length}`);
  }

  if (sourceLinkCount(evidence) === 0) {
    failures.push("expected at least one source-linked evidence row");
  }

  if ((summaryText ?? "").length > scenario.maximumPackSize) {
    failures.push(`continuity pack too large: ${(summaryText ?? "").length} > ${scenario.maximumPackSize}`);
  }

  if ((scenario.minimumTaskCount ?? 0) > taskCount) {
    failures.push(`expected at least ${scenario.minimumTaskCount} tasks, got ${taskCount}`);
  }

  if ((scenario.minimumCalendarCount ?? 0) > calendarCount) {
    failures.push(`expected at least ${scenario.minimumCalendarCount} commitments, got ${calendarCount}`);
  }

  for (const term of scenario.expectedSourcePathTerms ?? []) {
    if (!sourcePaths.some((item) => item.includes(term))) {
      failures.push(`missing source path term ${term}`);
    }
  }

  const clarificationSuggested = hasTerm(payload?.followUpAction, "clarif") || hasTerm(payload, "clarification");
  const failureCategories: ProductionFailureCategory[] = [];
  const continuityMissingEvidence = evidence.length === 0;
  const continuityWrongClaimWithGoodEvidence = evidence.length > 0 && failures.length > 0;

  if (continuityMissingEvidence) {
    failureCategories.push("missing_evidence");
  }
  if (continuityWrongClaimWithGoodEvidence) {
    failureCategories.push("wrong_claim_with_good_evidence");
  }
  if (sourceLinkCount(evidence) === 0) {
    failureCategories.push("weak_provenance");
  }
  if (scenario.tool === "memory.extract_tasks" && failures.length > 0) {
    failureCategories.push("task_extraction_error");
  }
  if (scenario.tool === "memory.recap" || scenario.tool === "memory.explain_recap") {
    if (failures.length > 0) {
      failureCategories.push("continuity_pack_error");
    }
  }

  return {
    name: scenario.name,
    tool: scenario.tool,
    query: scenario.prompt,
    latencyMs,
    confidence,
    sufficiency,
    subjectMatch,
    continuityPackSize: (summaryText ?? "").length,
    continuityEvidenceCount: evidence.length,
    continuitySourceLinkCount: sourceLinkCount(evidence),
    continuityTaskCount: taskCount,
    continuityCalendarCount: calendarCount,
    continuityClarificationSuggested: clarificationSuggested,
    dominantStage: typeof payload?.meta?.dominantStage === "string" ? payload.meta.dominantStage : null,
    topStageMs: typeof payload?.meta?.topStageMs === "number" ? payload.meta.topStageMs : null,
    leafTraversalTriggered: payload?.meta?.leafTraversalTriggered === true,
    descentTriggered: payload?.meta?.descentTriggered === true,
    descentStages: Array.isArray(payload?.meta?.descentStages) ? payload.meta.descentStages.filter((value: unknown): value is string => typeof value === "string") : [],
    reducerFamily: typeof payload?.meta?.reducerFamily === "string" ? payload.meta.reducerFamily : null,
    finalClaimSource: typeof payload?.meta?.finalClaimSource === "string" ? payload.meta.finalClaimSource : null,
    fallbackSuppressedReason: typeof payload?.meta?.fallbackSuppressedReason === "string" ? payload.meta.fallbackSuppressedReason : null,
    stageTimingsMs: stageTimingsFromPayload(payload),
    summaryText,
    sourcePaths,
    status: failures.length === 0 ? "pass" : "fail",
    primaryFailureCategory: failureCategories[0] ?? null,
    failureCategories,
    failures
  };
}

function toMarkdown(report: PersonalOpenClawReviewReport): string {
  const lines: string[] = [
    "# Personal OpenClaw Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- fixtureRoot: ${report.fixtureRoot}`,
    `- sourceId: ${report.source.id}`,
    `- filesImported: ${report.source.filesImported}`,
    `- sourceShapePassed: ${report.sourceShape.passed}`,
    `- pass/fail: ${report.summary.pass}/${report.summary.fail}`,
    `- answerableContinuityQuestions: ${report.summary.answerableContinuityQuestions}`,
    `- continuityMissingEvidence: ${report.summary.continuityMissingEvidence}`,
    `- continuityWrongClaimWithGoodEvidence: ${report.summary.continuityWrongClaimWithGoodEvidence}`,
    "",
    "## Source Shape",
    ""
  ];

  for (const failure of report.sourceShape.failures) {
    lines.push(`- ${failure}`);
  }

  if (report.sourceShape.failures.length === 0) {
    lines.push("- all expected OpenClaw file roles were tagged correctly");
  }

  lines.push("");
  lines.push("## Scenarios");
  lines.push("");

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.name}`);
    lines.push(`- tool: ${scenario.tool}`);
    lines.push(`- status: ${scenario.status}`);
    lines.push(`- confidence: ${scenario.confidence ?? "missing"}`);
    lines.push(`- sufficiency/subjectMatch: ${scenario.sufficiency ?? "missing"} / ${scenario.subjectMatch ?? "missing"}`);
    lines.push(`- continuityPackSize: ${scenario.continuityPackSize}`);
    lines.push(`- continuityEvidenceCount: ${scenario.continuityEvidenceCount}`);
    lines.push(`- continuitySourceLinkCount: ${scenario.continuitySourceLinkCount}`);
    lines.push(`- continuityTaskCount: ${scenario.continuityTaskCount}`);
    lines.push(`- continuityCalendarCount: ${scenario.continuityCalendarCount}`);
    lines.push(`- continuityClarificationSuggested: ${scenario.continuityClarificationSuggested}`);
    lines.push(`- dominantStage/topStageMs: ${scenario.dominantStage ?? "n/a"} / ${scenario.topStageMs ?? "n/a"}`);
    lines.push(`- leafTraversalTriggered: ${scenario.leafTraversalTriggered}`);
    lines.push(`- descentTriggered: ${scenario.descentTriggered}`);
    lines.push(`- descentStages: ${scenario.descentStages.join(" -> ") || "none"}`);
    lines.push(`- reducerFamily: ${scenario.reducerFamily ?? "none"}`);
    lines.push(`- finalClaimSource: ${scenario.finalClaimSource ?? "none"}`);
    lines.push(`- fallbackSuppressedReason: ${scenario.fallbackSuppressedReason ?? "none"}`);
    if (scenario.stageTimingsMs) {
      lines.push(`- stageTimingsMs: ${JSON.stringify(scenario.stageTimingsMs)}`);
    }
    lines.push(`- primaryFailureCategory: ${scenario.primaryFailureCategory ?? "none"}`);
    lines.push(`- failureCategories: ${scenario.failureCategories.join(", ") || "none"}`);
    lines.push(`- query: ${scenario.query}`);
    if (scenario.summaryText) {
      lines.push(`- summary: ${scenario.summaryText}`);
    }
    if (scenario.sourcePaths.length > 0) {
      lines.push(`- sourcePaths: ${scenario.sourcePaths.join(" | ")}`);
    }
    if (scenario.failures.length > 0) {
      lines.push(`- failures: ${scenario.failures.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runAndWritePersonalOpenClawReviewBenchmark(
  namespaceId = DEFAULT_NAMESPACE_ID
): Promise<{
  readonly report: PersonalOpenClawReviewReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  return withMaintenanceLock("the personal OpenClaw continuity benchmark", async () => {
    await runMigrations();
    await upsertNamespaceSelfProfile({
      namespaceId,
      canonicalName: "Steve Tietze",
      aliases: ["Steve"],
      note: "Shadow self anchor for OpenClaw continuity benchmarking."
    });

    const source = await ensureSource(namespaceId);
    await scanMonitoredSource(source.id);
    const sourceShape = await verifySourceShape(source.id);
    const importResult = await importMonitoredSource(source.id, "onboarding");
    await rebuildNamespace(namespaceId);

    const scenarioResults: ContinuityScenarioResult[] = [];
    for (const scenario of scenarios(namespaceId)) {
      scenarioResults.push(await runScenario(namespaceId, scenario));
    }

    const report: PersonalOpenClawReviewReport = {
      generatedAt: new Date().toISOString(),
      namespaceId,
      fixtureRoot: fixtureRoot(),
      source: {
        id: source.id,
        label: source.label,
        rootPath: source.rootPath,
        filesImported: importResult.importRun.filesImported
      },
      sourceShape,
      scenarios: scenarioResults,
      summary: {
        pass: scenarioResults.filter((item) => item.status === "pass").length,
        fail: scenarioResults.filter((item) => item.status === "fail").length,
        answerableContinuityQuestions: scenarioResults.filter((item) => item.continuityEvidenceCount > 0).length,
        continuityMissingEvidence: scenarioResults.filter((item) => item.continuityEvidenceCount === 0).length,
        continuityWrongClaimWithGoodEvidence: scenarioResults.filter(
          (item) => item.continuityEvidenceCount > 0 && item.status === "fail"
        ).length,
        failureCategoryCounts: countFailureCategories(scenarioResults)
      }
    };

    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const jsonPath = path.join(dir, `personal-openclaw-review-${stamp}.json`);
    const markdownPath = path.join(dir, `personal-openclaw-review-${stamp}.md`);
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

export async function runPersonalOpenClawReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWritePersonalOpenClawReviewBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
