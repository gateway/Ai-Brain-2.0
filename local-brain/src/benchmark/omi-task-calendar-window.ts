import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runOmiLatestSync } from "./omi-latest-sync.js";

type ScenarioToolName = "memory.recap" | "memory.extract_tasks" | "memory.extract_calendar";

interface OmiRawActionItem {
  readonly description?: string | null;
}

interface OmiRawEvent {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly start?: string | null;
}

interface OmiRawConversation {
  readonly id?: string | null;
  readonly created_at?: string | null;
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
  readonly structured?: {
    readonly title?: string | null;
    readonly overview?: string | null;
    readonly action_items?: readonly OmiRawActionItem[];
    readonly events?: readonly OmiRawEvent[];
  } | null;
}

interface BenchmarkScenario {
  readonly id: string;
  readonly tool: ScenarioToolName;
  readonly query: string;
  readonly minimumItems: number;
  readonly requiredKeywordGroups: readonly (readonly string[])[];
  readonly forbiddenTerms: readonly string[];
}

interface ScenarioMetric {
  readonly id: string;
  readonly tool: ScenarioToolName;
  readonly query: string;
  readonly passed: boolean;
  readonly evidenceCount: number;
  readonly itemCount: number;
  readonly latestSourceOnly: boolean;
  readonly missingKeywordGroups: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly sourceTrail: readonly string[];
  readonly itemPreview: readonly string[];
}

export interface OmiTaskCalendarWindowReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly latestNote: {
    readonly absolutePath: string;
    readonly rawPath: string;
    readonly conversationId: string | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly title: string | null;
    readonly actionItemCount: number;
    readonly eventCount: number;
  };
  readonly baseline: {
    readonly recapPassed: boolean;
    readonly taskExtractionPassed: boolean;
    readonly calendarExtractionPassed: boolean;
    readonly latestSourceOnlyCount: number;
    readonly failedScenarioCount: number;
  };
  readonly scenarios: readonly ScenarioMetric[];
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

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function deriveRawPath(normalizedPath: string): string {
  if (normalizedPath.includes("/normalized/")) {
    return normalizedPath.replace("/normalized/", "/raw/").replace(/\.md$/u, ".json");
  }
  throw new Error(`Could not derive raw OMI path from normalized path: ${normalizedPath}`);
}

function stopwords(): ReadonlySet<string> {
  return new Set([
    "the",
    "and",
    "with",
    "from",
    "that",
    "this",
    "then",
    "they",
    "also",
    "need",
    "needs",
    "deal",
    "get",
    "for",
    "about",
    "will",
    "into",
    "stay",
    "trip",
    "user",
    "plan",
    "plans",
    "going",
    "late",
    "mid",
    "long",
    "term",
    "month",
    "half",
    "week",
    "after",
    "before",
    "through",
    "most",
    "possible",
    "running",
    "handle"
  ]);
}

function keywordsForPhrase(phrase: string): readonly string[] {
  const normalized = normalizeText(phrase);
  return uniqueStrings(
    normalized
      .split(" ")
      .filter((token) => token.length >= 2 && !stopwords().has(token))
      .slice(0, 5)
  );
}

function latestWindowKeywordGroups(raw: OmiRawConversation): {
  readonly taskGroups: readonly (readonly string[])[];
  readonly calendarGroups: readonly (readonly string[])[];
} {
  const taskGroups = (raw.structured?.action_items ?? [])
    .map((item) => keywordsForPhrase(String(item.description ?? "")))
    .filter((group) => group.length > 0);

  const eventGroups = (raw.structured?.events ?? [])
    .map((event) => keywordsForPhrase(`${event.title ?? ""} ${event.description ?? ""}`))
    .filter((group) => group.length > 0);

  const overviewGroups = raw.structured?.overview
    ? [keywordsForPhrase(raw.structured.overview)]
    : [];

  return {
    taskGroups,
    calendarGroups: eventGroups.length > 0 ? eventGroups : overviewGroups.filter((group) => group.length > 0)
  };
}

function buildScenarios(raw: OmiRawConversation): readonly BenchmarkScenario[] {
  const keywordGroups = latestWindowKeywordGroups(raw);
  return [
    {
      id: "latest_note_recap",
      tool: "memory.recap",
      query: "What were the latest things I mentioned in my most recent OMI note?",
      minimumItems: 0,
      requiredKeywordGroups: keywordGroups.taskGroups.slice(0, 4),
      forbiddenTerms: []
    },
    {
      id: "latest_note_tasks",
      tool: "memory.extract_tasks",
      query: "What tasks did I mention in my most recent OMI note?",
      minimumItems: keywordGroups.taskGroups.length > 0 ? Math.max(1, Math.min(keywordGroups.taskGroups.length, 4)) : 0,
      requiredKeywordGroups: keywordGroups.taskGroups.slice(0, 4),
      forbiddenTerms: ["turkey", "two-way", "conference", "istanbul"]
    },
    {
      id: "latest_note_calendar",
      tool: "memory.extract_calendar",
      query: "What trips, dates, or commitments did I mention in my most recent OMI note?",
      minimumItems: (raw.structured?.events ?? []).length > 0 ? Math.max(1, Math.min((raw.structured?.events ?? []).length, 3)) : 0,
      requiredKeywordGroups: keywordGroups.calendarGroups.slice(0, 4),
      forbiddenTerms: ["turkey", "two-way", "conference", "istanbul", "tomorrow"]
    }
  ];
}

function scenarioItems(tool: ScenarioToolName, payload: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (tool === "memory.extract_tasks" && Array.isArray(payload.tasks)) {
    return payload.tasks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  if (tool === "memory.extract_calendar" && Array.isArray(payload.commitments)) {
    return payload.commitments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

function scenarioPreview(tool: ScenarioToolName, payload: Record<string, unknown>): readonly string[] {
  if (tool === "memory.extract_tasks") {
    return scenarioItems(tool, payload)
      .map((item) => String(item.title ?? item.description ?? "").trim())
      .filter((value) => value.length > 0)
      .slice(0, 6);
  }
  if (tool === "memory.extract_calendar") {
    return scenarioItems(tool, payload)
      .map((item) => String(item.title ?? "").trim())
      .filter((value) => value.length > 0)
      .slice(0, 6);
  }

  const humanReadable = payload.humanReadable;
  if (humanReadable && typeof humanReadable === "object" && typeof (humanReadable as { readonly answer?: unknown }).answer === "string") {
    return [String((humanReadable as { readonly answer: string }).answer)];
  }
  return [];
}

function sourceUrisForPayload(payload: Record<string, unknown>): readonly string[] {
  const sourceTrail = Array.isArray(payload.sourceTrail) ? payload.sourceTrail : [];
  return uniqueStrings(
    sourceTrail
      .map((entry) => (entry && typeof entry === "object" ? String((entry as { readonly sourceUri?: unknown }).sourceUri ?? "").trim() : ""))
      .filter((value) => value.length > 0)
  );
}

function evidenceCountForPayload(payload: Record<string, unknown>): number {
  return Array.isArray(payload.evidence) ? payload.evidence.length : 0;
}

function contentBlob(tool: ScenarioToolName, payload: Record<string, unknown>): string {
  const items = scenarioItems(tool, payload);
  const preview = scenarioPreview(tool, payload);
  const humanReadable =
    payload.humanReadable && typeof payload.humanReadable === "object"
      ? payload.humanReadable
      : null;
  return normalizeText(JSON.stringify({ items, preview, humanReadable }));
}

function missingKeywordGroups(blob: string, groups: readonly (readonly string[])[]): readonly string[] {
  const missing: string[] = [];
  for (const group of groups) {
    if (group.length === 0) {
      continue;
    }
    const matched = group.some((keyword) => blob.includes(normalizeText(keyword)));
    if (!matched) {
      missing.push(group.join("|"));
    }
  }
  return missing;
}

function forbiddenHits(blob: string, terms: readonly string[]): readonly string[] {
  return terms.filter((term) => blob.includes(normalizeText(term)));
}

async function runScenario(
  scenario: BenchmarkScenario,
  params: {
    readonly namespaceId: string;
    readonly timeStart: string;
    readonly timeEnd: string;
    readonly latestSource: string;
  }
): Promise<ScenarioMetric> {
  const wrapped = (await executeMcpTool(scenario.tool, {
    namespace_id: params.namespaceId,
    query: scenario.query,
    time_start: params.timeStart,
    time_end: params.timeEnd,
    detail_mode: "full",
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = (wrapped.structuredContent ?? {}) as Record<string, unknown>;
  const itemPreview = scenarioPreview(scenario.tool, payload);
  const blob = contentBlob(scenario.tool, payload);
  const sourceTrail = sourceUrisForPayload(payload);
  const missingGroups = missingKeywordGroups(blob, scenario.requiredKeywordGroups);
  const forbidden = forbiddenHits(blob, scenario.forbiddenTerms);
  const latestSourceOnly = sourceTrail.length > 0 && sourceTrail.every((uri) => uri === params.latestSource);
  const itemCount = scenario.tool === "memory.recap" ? itemPreview.length : scenarioItems(scenario.tool, payload).length;
  const failures: string[] = [];

  if (evidenceCountForPayload(payload) === 0) {
    failures.push("missing grounded evidence");
  }
  if (sourceTrail.length === 0) {
    failures.push("missing source trail");
  }
  if (!latestSourceOnly) {
    failures.push("source trail leaked outside the latest OMI artifact");
  }
  if (itemCount < scenario.minimumItems) {
    failures.push(`expected at least ${scenario.minimumItems} items, got ${itemCount}`);
  }
  if (missingGroups.length > 0) {
    failures.push(`missing keyword groups: ${missingGroups.join(", ")}`);
  }
  if (forbidden.length > 0) {
    failures.push(`forbidden leak terms present: ${forbidden.join(", ")}`);
  }

  return {
    id: scenario.id,
    tool: scenario.tool,
    query: scenario.query,
    passed: failures.length === 0,
    evidenceCount: evidenceCountForPayload(payload),
    itemCount,
    latestSourceOnly,
    missingKeywordGroups: missingGroups,
    forbiddenHits: forbidden,
    sourceTrail,
    itemPreview
  };
}

function markdown(report: OmiTaskCalendarWindowReport): string {
  const lines = [
    "# OMI Task Calendar Window Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- latestNote: ${report.latestNote.absolutePath}`,
    `- rawPath: ${report.latestNote.rawPath}`,
    `- startedAt: ${report.latestNote.startedAt ?? "unknown"}`,
    `- finishedAt: ${report.latestNote.finishedAt ?? "unknown"}`,
    `- actionItemCount: ${report.latestNote.actionItemCount}`,
    `- eventCount: ${report.latestNote.eventCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Baseline",
    "",
    `- recapPassed: ${report.baseline.recapPassed}`,
    `- taskExtractionPassed: ${report.baseline.taskExtractionPassed}`,
    `- calendarExtractionPassed: ${report.baseline.calendarExtractionPassed}`,
    `- latestSourceOnlyCount: ${report.baseline.latestSourceOnlyCount}`,
    `- failedScenarioCount: ${report.baseline.failedScenarioCount}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id}`);
    lines.push(`- tool: ${scenario.tool}`);
    lines.push(`- passed: ${scenario.passed}`);
    lines.push(`- evidenceCount: ${scenario.evidenceCount}`);
    lines.push(`- itemCount: ${scenario.itemCount}`);
    lines.push(`- latestSourceOnly: ${scenario.latestSourceOnly}`);
    if (scenario.missingKeywordGroups.length > 0) {
      lines.push(`- missingKeywordGroups: ${scenario.missingKeywordGroups.join(", ")}`);
    }
    if (scenario.forbiddenHits.length > 0) {
      lines.push(`- forbiddenHits: ${scenario.forbiddenHits.join(", ")}`);
    }
    if (scenario.itemPreview.length > 0) {
      lines.push(`- itemPreview: ${scenario.itemPreview.join(" | ")}`);
    }
    if (scenario.sourceTrail.length > 0) {
      lines.push(`- sourceTrail: ${scenario.sourceTrail.join(" | ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runOmiTaskCalendarWindowBenchmark(namespaceId = "personal"): Promise<{
  readonly report: OmiTaskCalendarWindowReport;
  readonly artifactPath: string;
}> {
  const sync = await runOmiLatestSync({
    namespaceId,
    skipCompiler: true
  });
  const normalizedPath = sync.report.latestFile.absolutePath;
  const rawPath = deriveRawPath(normalizedPath);
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as OmiRawConversation;
  const timeStart = String(raw.started_at ?? raw.created_at ?? "");
  const timeEnd = String(raw.finished_at ?? raw.started_at ?? raw.created_at ?? "");

  if (!timeStart || !timeEnd) {
    throw new Error(`Latest OMI note is missing started_at/finished_at: ${rawPath}`);
  }

  const scenarios = buildScenarios(raw);
  const results: ScenarioMetric[] = [];
  for (const scenario of scenarios) {
    results.push(
      await runScenario(scenario, {
        namespaceId,
        timeStart,
        timeEnd,
        latestSource: normalizedPath
      })
    );
  }

  const report: OmiTaskCalendarWindowReport = {
    generatedAt: new Date().toISOString(),
    namespaceId,
    latestNote: {
      absolutePath: normalizedPath,
      rawPath,
      conversationId: raw.id ?? null,
      startedAt: raw.started_at ?? null,
      finishedAt: raw.finished_at ?? null,
      title: raw.structured?.title ?? null,
      actionItemCount: (raw.structured?.action_items ?? []).length,
      eventCount: (raw.structured?.events ?? []).length
    },
    baseline: {
      recapPassed: results.find((result) => result.id === "latest_note_recap")?.passed === true,
      taskExtractionPassed: results.find((result) => result.id === "latest_note_tasks")?.passed === true,
      calendarExtractionPassed: results.find((result) => result.id === "latest_note_calendar")?.passed === true,
      latestSourceOnlyCount: results.filter((result) => result.latestSourceOnly).length,
      failedScenarioCount: results.filter((result) => !result.passed).length
    },
    scenarios: results,
    passed:
      results.find((result) => result.id === "latest_note_tasks")?.passed === true &&
      results.find((result) => result.id === "latest_note_calendar")?.passed === true
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const artifactPath = path.join(dir, `omi-task-calendar-window-${stamp}.json`);
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, `omi-task-calendar-window-${stamp}.md`), markdown(report), "utf8");
  return { report, artifactPath };
}

export async function runOmiTaskCalendarWindowBenchmarkCli(): Promise<void> {
  try {
    const namespaceFlagIndex = process.argv.indexOf("--namespace-id");
    const namespaceId = namespaceFlagIndex >= 0 ? process.argv[namespaceFlagIndex + 1] ?? "personal" : "personal";
    const { report, artifactPath } = await runOmiTaskCalendarWindowBenchmark(namespaceId);
    process.stdout.write(
      `${JSON.stringify(
        {
          artifactPath,
          passed: report.passed,
          baseline: report.baseline,
          latestNote: report.latestNote
        },
        null,
        2
      )}\n`
    );
  } finally {
    await closePool();
  }
}
