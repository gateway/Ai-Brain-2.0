import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";
import { runAndWriteLifeReplayBenchmark } from "./life-replay.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";
import { runAndWritePublicDatasetWatchBenchmark } from "./public-dataset-watch.js";

type ReviewTool =
  | "memory.search"
  | "memory.recap"
  | "memory.extract_tasks"
  | "memory.extract_calendar"
  | "memory.explain_recap";

type ReviewVerdict =
  | "pass"
  | "warning"
  | "fail";

type FailureMode =
  | "wrong"
  | "weak"
  | "missing"
  | "right_data_wrong_wording"
  | "source_gap"
  | "clarification_expected"
  | "manual_review_needed";

interface ReviewScenario {
  readonly name: string;
  readonly namespaceResolver: "personal" | "synthetic" | "omi" | "public";
  readonly tool: ReviewTool;
  readonly query: string;
  readonly referenceNow?: string;
  readonly limit?: number;
  readonly description: string;
  readonly expectedConfidence?: "confident" | "weak" | "missing";
  readonly expectedTerms?: readonly string[];
  readonly minimumEvidence?: number;
}

interface BoundReviewScenario extends ReviewScenario {
  readonly namespaceId: string;
}

interface ReviewEvidenceRow {
  readonly memoryId?: string;
  readonly memoryType?: string;
  readonly artifactId?: string;
  readonly occurredAt?: string;
  readonly sourceUri?: string;
  readonly snippet?: string;
}

interface ReviewScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly namespaceId: string;
  readonly tool: ReviewTool;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: string | null;
  readonly followUpAction: string | null;
  readonly resolvedWindow: unknown;
  readonly focus: unknown;
  readonly retrievalPlan: unknown;
  readonly summaryText: string | null;
  readonly llmStyleAnswer: string | null;
  readonly evidence: readonly ReviewEvidenceRow[];
  readonly sourcePaths: readonly string[];
  readonly automatedVerdict: ReviewVerdict;
  readonly automatedFailureModes: readonly FailureMode[];
  readonly automatedNotes: readonly string[];
  readonly humanReview: {
    readonly operatorVerdict: null;
    readonly selectedFailureModes: readonly [];
    readonly notes: null;
  };
}

export interface NaturalQueryReviewBenchmarkReport {
  readonly generatedAt: string;
  readonly prerequisiteReportPaths: {
    readonly replay: string;
    readonly synthetic: string;
    readonly omi: string;
    readonly publicDataset: string;
  };
  readonly scenarios: readonly ReviewScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
  };
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

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function trimSnippet(value: unknown, max = 220): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  return [];
}

function extractSourcePaths(evidence: readonly ReviewEvidenceRow[]): readonly string[] {
  return [...new Set(evidence.map((item) => item.sourceUri).filter((item): item is string => typeof item === "string" && item.length > 0))];
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
      const due = typeof task?.dueHint === "string" && task.dueHint ? ` due ${task.dueHint}` : "";
      return `- ${title}${project}${due}`;
    })
    .join("\n");
}

function summarizeCommitments(payload: any): string | null {
  const commitments = Array.isArray(payload?.commitments) ? payload.commitments : [];
  if (commitments.length === 0) {
    return null;
  }
  return commitments
    .slice(0, 5)
    .map((item: any) => {
      const title = typeof item?.title === "string" ? item.title : "untitled commitment";
      const timeHint = typeof item?.timeHint === "string" && item.timeHint ? ` at ${item.timeHint}` : "";
      const location = typeof item?.locationHint === "string" && item.locationHint ? ` in ${item.locationHint}` : "";
      return `- ${title}${timeHint}${location}`;
    })
    .join("\n");
}

function llmStyleAnswer(payload: any, tool: ReviewTool): string | null {
  if (tool === "memory.recap" || tool === "memory.explain_recap") {
    if (typeof payload?.summaryText === "string" && payload.summaryText.trim()) {
      return payload.summaryText.trim();
    }
    if (typeof payload?.claimText === "string" && payload.claimText.trim()) {
      return payload.claimText.trim();
    }
    if (typeof payload?.explanation === "string" && payload.explanation.trim()) {
      return payload.explanation.trim();
    }
  }

  if (tool === "memory.extract_tasks") {
    return summarizeTasks(payload);
  }

  if (tool === "memory.extract_calendar") {
    return summarizeCommitments(payload);
  }

  if (typeof payload?.duality?.claim?.text === "string" && payload.duality.claim.text.trim()) {
    const snippets = evidenceItems(payload)
      .slice(0, 4)
      .map((item: any) => trimSnippet(item?.snippet))
      .filter((item): item is string => typeof item === "string" && item.length > 0);
    if (snippets.length > 1) {
      return snippets.join("; ");
    }
    return payload.duality.claim.text.trim();
  }

  return null;
}

function toEvidenceRows(payload: any): readonly ReviewEvidenceRow[] {
  return evidenceItems(payload).slice(0, 8).map((item: any) => ({
    memoryId: typeof item?.memoryId === "string" ? item.memoryId : undefined,
    memoryType: typeof item?.memoryType === "string" ? item.memoryType : undefined,
    artifactId: typeof item?.artifactId === "string" ? item.artifactId : undefined,
    occurredAt: typeof item?.occurredAt === "string" ? item.occurredAt : undefined,
    sourceUri: typeof item?.sourceUri === "string" ? item.sourceUri : undefined,
    snippet: trimSnippet(item?.snippet)
  }));
}

function resolveNamespaceId(
  namespaceIds: {
    readonly personal: string;
    readonly synthetic: string;
    readonly omi: string;
    readonly public: string;
  },
  namespaceResolver: ReviewScenario["namespaceResolver"]
): string {
  switch (namespaceResolver) {
    case "personal":
      return namespaceIds.personal;
    case "synthetic":
      return namespaceIds.synthetic;
    case "omi":
      return namespaceIds.omi;
    case "public":
      return namespaceIds.public;
  }
}

function scenarios(namespaceIds: {
  readonly personal: string;
  readonly synthetic: string;
  readonly omi: string;
  readonly public: string;
}): readonly BoundReviewScenario[] {
  const definitions: readonly ReviewScenario[] = [
    {
      name: "friends_overview",
      namespaceResolver: "personal",
      tool: "memory.search",
      query: "who are Steve's friends?",
      limit: 5,
      description: "Direct relationship lookup for a normal social question.",
      expectedConfidence: "confident",
      expectedTerms: ["Dan", "Lauren"],
      minimumEvidence: 2
    },
    {
      name: "movie_preferences",
      namespaceResolver: "personal",
      tool: "memory.search",
      query: "what movies does Steve like?",
      limit: 5,
      description: "Media preference lookup with current preference rows.",
      expectedConfidence: "confident",
      expectedTerms: ["Trainspotting", "Sinners"],
      minimumEvidence: 2
    },
    {
      name: "coffee_current_state",
      namespaceResolver: "personal",
      tool: "memory.search",
      query: "what coffee does Steve prefer now?",
      limit: 5,
      description: "Current-vs-historical preference retrieval for a natural phrasing.",
      expectedConfidence: "confident",
      expectedTerms: ["pour-over", "espresso"],
      minimumEvidence: 2
    },
    {
      name: "project_recap_yesterday",
      namespaceResolver: "synthetic",
      tool: "memory.recap",
      query: "Give me an overview of what Steve and Dan said about Project A yesterday.",
      referenceNow: "2026-03-21T12:00:00Z",
      limit: 8,
      description: "Recap-style project question with participant and time anchors.",
      expectedConfidence: "confident",
      expectedTerms: ["Project A", "Dan"],
      minimumEvidence: 1
    },
    {
      name: "project_temporal_delta",
      namespaceResolver: "synthetic",
      tool: "memory.recap",
      query: "What changed on Project A this week?",
      referenceNow: "2026-03-23T12:00:00Z",
      limit: 8,
      description: "Temporal-differential recap over a rolling week with change evidence and baseline context.",
      expectedConfidence: "confident",
      expectedTerms: ["Project A", "green", "deadline", "vendor API"],
      minimumEvidence: 2
    },
    {
      name: "project_task_list",
      namespaceResolver: "synthetic",
      tool: "memory.extract_tasks",
      query: "Make a task list from what Steve mentioned yesterday about Project A.",
      referenceNow: "2026-03-21T12:00:00Z",
      limit: 8,
      description: "Task extraction over grounded evidence.",
      expectedConfidence: "confident",
      expectedTerms: ["Project A", "demo outline", "Mia"],
      minimumEvidence: 1
    },
    {
      name: "weekend_calendar",
      namespaceResolver: "synthetic",
      tool: "memory.extract_calendar",
      query: "Pull calendar items from last weekend.",
      referenceNow: "2026-03-23T12:00:00Z",
      limit: 8,
      description: "Calendar-like commitment extraction from a weekend recap window.",
      expectedConfidence: "confident",
      expectedTerms: ["Punspace", "Monday morning"],
      minimumEvidence: 1
    },
    {
      name: "omi_conversation_recap",
      namespaceResolver: "omi",
      tool: "memory.recap",
      query: "Can you give me an overview of that conversation I had with Dan on March 22 2026 about ladyboys?",
      referenceNow: "2026-03-23T12:00:00Z",
      limit: 5,
      description: "OMI conversation recap with participant, topic, and absolute date anchor.",
      expectedConfidence: "confident",
      expectedTerms: ["ladyboys", "Dan", "Rhonda"],
      minimumEvidence: 1
    },
    {
      name: "omi_explain_recap",
      namespaceResolver: "omi",
      tool: "memory.explain_recap",
      query: "Why do you think that was the right conversation I had with Dan on March 22 2026 about ladyboys?",
      referenceNow: "2026-03-23T12:00:00Z",
      limit: 5,
      description: "Provenance and explainability for the OMI recap result.",
      expectedConfidence: "confident",
      expectedTerms: ["March 22 2026", "grouped"],
      minimumEvidence: 1
    },
    {
      name: "public_profile_summary",
      namespaceResolver: "public",
      tool: "memory.search",
      query:
        "I am trying to remember what Martin Mark's life looks like right now instead of reading a profile blob. Can you piece together where he lives, who his close people and coworkers are, what kinds of travel or places he prefers, and anything solid we know versus anything that still needs clarification? Please show why the brain believes the main points instead of only giving a loose summary.",
      limit: 10,
      description: "Public imported profile recap for third-person retrieval and evidence review.",
      expectedConfidence: "confident",
      expectedTerms: ["Martin Mark", "Columbus", "Susan Thomas", "Wellness retreats"],
      minimumEvidence: 4
    },
    {
      name: "uncle_ambiguity",
      namespaceResolver: "personal",
      tool: "memory.search",
      query: "who is Uncle?",
      limit: 6,
      description: "Intentional ambiguity case to verify missing plus clarification behavior.",
      expectedConfidence: "missing",
      expectedTerms: ["Unknown"],
      minimumEvidence: 0
    }
  ];

  return definitions.map((scenario): BoundReviewScenario => ({
    ...scenario,
    namespaceId: resolveNamespaceId(namespaceIds, scenario.namespaceResolver)
  }));
}

async function runScenario(
  scenario: BoundReviewScenario
): Promise<ReviewScenarioResult> {
  const started = Date.now();
  const wrapped = (await executeMcpTool(scenario.tool, {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    ...(scenario.referenceNow ? { reference_now: scenario.referenceNow } : {}),
    ...(scenario.limit ? { limit: scenario.limit } : {})
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped?.structuredContent as any;
  const latencyMs = Number((Date.now() - started).toFixed(2));
  const evidence = toEvidenceRows(payload);
  const notes: string[] = [];
  const failureModes: FailureMode[] = [];
  const confidence =
    typeof payload?.confidence === "string"
      ? payload.confidence
      : typeof payload?.duality?.confidence === "string"
        ? payload.duality.confidence
        : null;
  const followUpAction =
    typeof payload?.followUpAction === "string"
      ? payload.followUpAction
      : typeof payload?.duality?.followUpAction === "string"
        ? payload.duality.followUpAction
        : null;

  if (scenario.expectedConfidence && confidence !== scenario.expectedConfidence) {
    notes.push(`Expected confidence ${scenario.expectedConfidence}, got ${confidence ?? "n/a"}.`);
    failureModes.push(confidence === "missing" ? "missing" : confidence === "weak" ? "weak" : "wrong");
  }

  if (typeof scenario.minimumEvidence === "number" && evidence.length < scenario.minimumEvidence) {
    notes.push(`Expected at least ${scenario.minimumEvidence} evidence rows, got ${evidence.length}.`);
    failureModes.push("source_gap");
  }

  for (const term of scenario.expectedTerms ?? []) {
    if (!hasTerm(payload, term)) {
      notes.push(`Missing expected term: ${term}.`);
      failureModes.push("right_data_wrong_wording");
    }
  }

  if (scenario.expectedConfidence === "missing" && followUpAction !== "route_to_clarifications") {
    notes.push("Expected clarification routing for ambiguous query.");
    failureModes.push("clarification_expected");
  }

  const uniqueFailureModes = [...new Set(failureModes)];
  const automatedVerdict: ReviewVerdict =
    uniqueFailureModes.length === 0
      ? "pass"
      : uniqueFailureModes.includes("wrong") || uniqueFailureModes.includes("missing")
        ? "fail"
        : "warning";

  return {
    name: scenario.name,
    description: scenario.description,
    namespaceId: scenario.namespaceId,
    tool: scenario.tool,
    query: scenario.query,
    latencyMs,
    confidence,
    followUpAction,
    resolvedWindow: payload?.resolvedWindow ?? null,
    focus: payload?.focus ?? null,
    retrievalPlan: payload?.retrievalPlan ?? payload?.meta?.planner ?? null,
    summaryText:
      typeof payload?.summaryText === "string"
        ? payload.summaryText
        : typeof payload?.claimText === "string"
          ? payload.claimText
          : null,
    llmStyleAnswer: llmStyleAnswer(payload, scenario.tool),
    evidence,
    sourcePaths: extractSourcePaths(evidence),
    automatedVerdict,
    automatedFailureModes: uniqueFailureModes,
    automatedNotes: notes,
    humanReview: {
      operatorVerdict: null,
      selectedFailureModes: [],
      notes: null
    }
  };
}

function markdownForScenario(result: ReviewScenarioResult): string {
  const lines: string[] = [
    `## ${result.name}`,
    "",
    `- description: ${result.description}`,
    `- tool: ${result.tool}`,
    `- namespaceId: ${result.namespaceId}`,
    `- automatedVerdict: ${result.automatedVerdict}`,
    `- confidence: ${result.confidence ?? "n/a"}`,
    `- followUpAction: ${result.followUpAction ?? "n/a"}`,
    `- latencyMs: ${result.latencyMs}`,
    "",
    "**Prompt**",
    "",
    result.query,
    "",
    "**Resolved Window**",
    "",
    "```json",
    JSON.stringify(result.resolvedWindow ?? null, null, 2),
    "```",
    "",
    "**Focus**",
    "",
    "```json",
    JSON.stringify(result.focus ?? null, null, 2),
    "```",
    "",
    "**LLM-Style Answer**",
    "",
    result.llmStyleAnswer ?? "_none_",
    "",
    "**Source Paths**",
    ""
  ];

  if (result.sourcePaths.length === 0) {
    lines.push("- none");
  } else {
    for (const sourcePath of result.sourcePaths) {
      lines.push(`- ${sourcePath}`);
    }
  }

  lines.push("", "**Evidence**", "");
  if (result.evidence.length === 0) {
    lines.push("- none");
  } else {
    for (const evidence of result.evidence) {
      lines.push(
        `- ${evidence.memoryType ?? "unknown"} | ${evidence.occurredAt ?? "n/a"} | ${evidence.sourceUri ?? "n/a"}`
      );
      lines.push(`  - ${evidence.snippet ?? "no snippet"}`);
    }
  }

  lines.push("", "**Retrieval Plan**", "", "```json", JSON.stringify(result.retrievalPlan ?? null, null, 2), "```", "");

  if (result.automatedNotes.length > 0) {
    lines.push("**Automated Notes**", "");
    for (const note of result.automatedNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push(
    "**Human Review**",
    "",
    "- operatorVerdict: `pass | warning | fail`",
    "- failureModes: `wrong | weak | missing | right_data_wrong_wording | source_gap | clarification_expected`",
    "- notes: _fill in during manual review_",
    ""
  );

  return lines.join("\n");
}

function toMarkdown(report: NaturalQueryReviewBenchmarkReport): string {
  const lines = [
    "# Natural Query Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- replay: ${report.prerequisiteReportPaths.replay}`,
    `- synthetic: ${report.prerequisiteReportPaths.synthetic}`,
    `- omi: ${report.prerequisiteReportPaths.omi}`,
    `- publicDataset: ${report.prerequisiteReportPaths.publicDataset}`,
    `- summary: pass=${report.summary.pass} warning=${report.summary.warning} fail=${report.summary.fail}`,
    "",
    "This report is meant for human inspection, not only release gating.",
    "Review each prompt like a real user request and decide whether the returned evidence and wording feel right.",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(markdownForScenario(scenario));
  }

  return `${lines.join("\n")}\n`;
}

export async function runAndWriteNaturalQueryReviewBenchmark(): Promise<{
  readonly report: NaturalQueryReviewBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const replay = await runAndWriteLifeReplayBenchmark();
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const omi = await runAndWriteOmiWatchSmokeBenchmark();
  const publicDataset = await runAndWritePublicDatasetWatchBenchmark();

  const namespaceIds = {
    personal: "personal",
    synthetic: synthetic.report.namespaceId,
    omi: omi.report.namespaceId,
    public: publicDataset.report.namespaceId
  } as const;

  const results: ReviewScenarioResult[] = [];
  for (const scenario of scenarios(namespaceIds)) {
    results.push(await runScenario(scenario));
  }

  const report: NaturalQueryReviewBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    prerequisiteReportPaths: {
      replay: replay.output.jsonPath,
      synthetic: synthetic.output.jsonPath,
      omi: omi.output.jsonPath,
      publicDataset: publicDataset.output.jsonPath
    },
    scenarios: results,
    summary: {
      pass: results.filter((item) => item.automatedVerdict === "pass").length,
      warning: results.filter((item) => item.automatedVerdict === "warning").length,
      fail: results.filter((item) => item.automatedVerdict === "fail").length
    }
  };

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `natural-query-review-${stamp}.json`);
  const markdownPath = path.join(outDir, `natural-query-review-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runNaturalQueryReviewBenchmarkCli(): Promise<void> {
  const { output, report } = await runAndWriteNaturalQueryReviewBenchmark();
  process.stdout.write(
    `${JSON.stringify(
      {
        summary: report.summary,
        jsonPath: output.jsonPath,
        markdownPath: output.markdownPath
      },
      null,
      2
    )}\n`
  );
  await closePool();
}
