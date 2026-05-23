import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runOmiLatestSync } from "./omi-latest-sync.js";

type ScenarioToolName = "memory.extract_tasks" | "memory.extract_calendar";

interface OmiRawActionItem {
  readonly description?: string | null;
  readonly completed?: boolean | null;
}

interface OmiRawEvent {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly start?: string | null;
}

interface OmiRawConversation {
  readonly id?: string | null;
  readonly started_at?: string | null;
  readonly finished_at?: string | null;
  readonly structured?: {
    readonly title?: string | null;
    readonly action_items?: readonly OmiRawActionItem[];
    readonly events?: readonly OmiRawEvent[];
  } | null;
}

interface BenchmarkScenario {
  readonly id: string;
  readonly tool: ScenarioToolName;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly referenceNow?: string;
  readonly minimumItems: number;
  readonly requiredKeywordGroups: readonly (readonly string[])[];
  readonly forbiddenTerms: readonly string[];
}

interface ScenarioMetric {
  readonly id: string;
  readonly tool: ScenarioToolName;
  readonly query: string;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
  readonly passed: boolean;
  readonly evidenceCount: number;
  readonly itemCount: number;
  readonly latestSourceOnly: boolean;
  readonly missingKeywordGroups: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly sourceTrail: readonly string[];
  readonly itemPreview: readonly string[];
}

export interface OmiTemporalTaskTravelWindowReport {
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
    readonly julyExplicitPassed: boolean;
    readonly julyInferredPassed: boolean;
    readonly septemberExplicitPassed: boolean;
    readonly taskLanePassed: boolean;
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
  if (!normalizedPath.includes("/normalized/")) {
    throw new Error(`Could not derive raw OMI path from normalized path: ${normalizedPath}`);
  }
  return normalizedPath.replace("/normalized/", "/raw/").replace(/\.md$/u, ".json");
}

function stopwords(): ReadonlySet<string> {
  return new Set([
    "the",
    "to",
    "out",
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
    "us",
    "plan",
    "plans",
    "fly",
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
  return uniqueStrings(
    normalizeText(phrase)
      .split(" ")
      .filter((token) => token.length >= 2 && !stopwords().has(token))
      .slice(0, 5)
  );
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
  return scenarioItems(tool, payload)
    .map((item) => String(item.title ?? item.description ?? "").trim())
    .filter((value) => value.length > 0)
    .slice(0, 6);
}

function contentBlob(tool: ScenarioToolName, payload: Record<string, unknown>): string {
  if (tool === "memory.extract_tasks") {
    return scenarioItems(tool, payload)
      .map((item) => `${String(item.title ?? "")} ${String(item.description ?? "")}`)
      .map((value) => normalizeText(value))
      .join(" ");
  }
  if (tool === "memory.extract_calendar") {
    return scenarioItems(tool, payload)
      .map((item) => `${String(item.title ?? "")} ${String(item.timeHint ?? "")} ${String(item.locationHint ?? "")}`)
      .map((value) => normalizeText(value))
      .join(" ");
  }
  return scenarioPreview(tool, payload)
    .map((value) => normalizeText(value))
    .join(" ");
}

function buildScenarios(raw: OmiRawConversation): readonly BenchmarkScenario[] {
  const taskGroups = (raw.structured?.action_items ?? [])
    .map((item) => keywordsForPhrase(String(item.description ?? "")))
    .filter((group) => group.length > 0)
    .slice(0, 4);
  const julyGroups = (raw.structured?.events ?? [])
    .filter((event) => /july/iu.test(`${event.title ?? ""} ${event.description ?? ""} ${event.start ?? ""}`))
    .map((event) => keywordsForPhrase(`${event.title ?? ""} ${event.description ?? ""}`))
    .filter((group) => group.length > 0);
  const septemberGroups = (raw.structured?.events ?? [])
    .filter((event) => /iceland|september|2026-09/iu.test(`${event.title ?? ""} ${event.description ?? ""} ${event.start ?? ""}`))
    .map((event) => keywordsForPhrase(`${event.title ?? ""} ${event.description ?? ""}`))
    .filter((group) => group.length > 0);

  return [
    {
      id: "latest_note_tasks",
      tool: "memory.extract_tasks",
      query: "What tasks did I mention in my most recent OMI note?",
      minimumItems: Math.max(2, taskGroups.length),
      requiredKeywordGroups: taskGroups,
      forbiddenTerms: ["turkey", "conference", "istanbul", "songkran"]
    },
    {
      id: "july_travel_explicit_window",
      tool: "memory.extract_calendar",
      query: "What trips or stays did I mention for July 2026?",
      timeStart: "2026-07-01T00:00:00.000Z",
      timeEnd: "2026-07-31T23:59:59.999Z",
      referenceNow: "2026-05-19T00:00:00.000Z",
      minimumItems: Math.max(1, Math.min(2, julyGroups.length)),
      requiredKeywordGroups: julyGroups.slice(0, 2),
      forbiddenTerms: ["turkey", "istanbul", "songkran", "tomorrow", "brunch"]
    },
    {
      id: "july_travel_inferred_window",
      tool: "memory.extract_calendar",
      query: "What trips did I mention for mid to late July?",
      referenceNow: "2026-05-19T00:00:00.000Z",
      minimumItems: Math.max(1, Math.min(1, julyGroups.length)),
      requiredKeywordGroups: julyGroups.slice(0, 1),
      forbiddenTerms: ["turkey", "istanbul", "songkran", "tomorrow", "brunch"]
    },
    {
      id: "september_travel_explicit_window",
      tool: "memory.extract_calendar",
      query: "What trips did I mention for September 2026?",
      timeStart: "2026-09-01T00:00:00.000Z",
      timeEnd: "2026-09-30T23:59:59.999Z",
      referenceNow: "2026-05-19T00:00:00.000Z",
      minimumItems: Math.max(1, Math.min(1, septemberGroups.length)),
      requiredKeywordGroups: septemberGroups.slice(0, 1),
      forbiddenTerms: ["turkey", "istanbul", "songkran", "tomorrow", "brunch"]
    }
  ];
}

function evaluateScenario(
  scenario: BenchmarkScenario,
  payload: Record<string, unknown>,
  latestSourceUri: string
): ScenarioMetric {
  const preview = scenarioPreview(scenario.tool, payload);
  const blob = contentBlob(scenario.tool, payload);
  const missingKeywordGroups = scenario.requiredKeywordGroups
    .filter((group) => group.length > 0)
    .filter((group) => !group.every((term) => blob.includes(normalizeText(term))))
    .map((group) => group.join(" "));
  const forbiddenHits = scenario.forbiddenTerms.filter((term) => blob.includes(normalizeText(term)));
  const sourceTrail = sourceUrisForPayload(payload);
  const latestSourceOnly = sourceTrail.length > 0 && sourceTrail.every((uri) => uri === latestSourceUri);
  const itemCount = scenarioItems(scenario.tool, payload).length;
  const passed =
    itemCount >= scenario.minimumItems &&
    missingKeywordGroups.length === 0 &&
    forbiddenHits.length === 0 &&
    latestSourceOnly;
  return {
    id: scenario.id,
    tool: scenario.tool,
    query: scenario.query,
    timeStart: scenario.timeStart ?? null,
    timeEnd: scenario.timeEnd ?? null,
    passed,
    evidenceCount: evidenceCountForPayload(payload),
    itemCount,
    latestSourceOnly,
    missingKeywordGroups,
    forbiddenHits,
    sourceTrail,
    itemPreview: preview
  };
}

export async function runOmiTemporalTaskTravelWindowBenchmark(namespaceId = "personal"): Promise<OmiTemporalTaskTravelWindowReport> {
  const latest = await runOmiLatestSync({ namespaceId });
  const normalizedPath = latest.report.latestFile.absolutePath;
  const rawPath = deriveRawPath(normalizedPath);
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as OmiRawConversation;
  const scenarios = buildScenarios(raw);

  const results: ScenarioMetric[] = [];
  for (const scenario of scenarios) {
    const toolArgs: Record<string, unknown> = {
      namespace_id: namespaceId,
      query: scenario.query
    };
    if (scenario.timeStart) {
      toolArgs.time_start = scenario.timeStart;
    }
    if (scenario.timeEnd) {
      toolArgs.time_end = scenario.timeEnd;
    }
    if (scenario.referenceNow) {
      toolArgs.reference_now = scenario.referenceNow;
    }
    const response = await executeMcpTool(scenario.tool, toolArgs);
    const content = Array.isArray((response as { readonly content?: unknown }).content)
      ? (response as { readonly content: readonly { readonly text?: string }[] }).content
      : [];
    const textPayload = content.find((entry) => typeof entry.text === "string")?.text;
    if (!textPayload) {
      throw new Error(`Tool ${scenario.tool} did not return a JSON text payload for ${scenario.id}.`);
    }
    const payload = JSON.parse(textPayload) as Record<string, unknown>;
    results.push(evaluateScenario(scenario, payload, normalizedPath));
  }

  const baseline = {
    julyExplicitPassed: results.find((entry) => entry.id === "july_travel_explicit_window")?.passed ?? false,
    julyInferredPassed: results.find((entry) => entry.id === "july_travel_inferred_window")?.passed ?? false,
    septemberExplicitPassed: results.find((entry) => entry.id === "september_travel_explicit_window")?.passed ?? false,
    taskLanePassed: results.find((entry) => entry.id === "latest_note_tasks")?.passed ?? false,
    latestSourceOnlyCount: results.filter((entry) => entry.latestSourceOnly).length,
    failedScenarioCount: results.filter((entry) => !entry.passed).length
  };

  return {
    generatedAt: new Date().toISOString(),
    namespaceId,
    latestNote: {
      absolutePath: normalizedPath,
      rawPath,
      conversationId: raw.id ?? null,
      startedAt: raw.started_at ?? null,
      finishedAt: raw.finished_at ?? null,
      title: raw.structured?.title ?? null,
      actionItemCount: raw.structured?.action_items?.length ?? 0,
      eventCount: raw.structured?.events?.length ?? 0
    },
    baseline,
    scenarios: results,
    passed: baseline.failedScenarioCount === 0
  };
}

export async function writeOmiTemporalTaskTravelWindowReport(report: OmiTemporalTaskTravelWindowReport): Promise<{ readonly jsonPath: string }> {
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `omi-temporal-task-travel-window-${stamp}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  return { jsonPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const namespaceId = process.argv[2] ?? "personal";
  runOmiTemporalTaskTravelWindowBenchmark(namespaceId)
    .then(async (report) => {
      const paths = await writeOmiTemporalTaskTravelWindowReport(report);
      console.log(JSON.stringify({ report, paths }, null, 2));
    })
    .finally(async () => {
      await closePool().catch(() => undefined);
    });
}
