import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
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
type QueryMode = "search" | "mcp_search" | "mcp_relationships";

interface QuerySpec {
  readonly name: string;
  readonly mode: QueryMode;
  readonly query?: string;
  readonly entityName?: string;
  readonly expectedTerms: readonly string[];
  readonly minimumConfidence?: Confidence;
  readonly knownGap?: boolean;
}

interface QueryResult {
  readonly name: string;
  readonly mode: QueryMode;
  readonly latencyMs: number;
  readonly confidence: Confidence | null;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface PublicDatasetWatchReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly source: {
    readonly id: string;
    readonly rootPath: string;
    readonly monitorEnabled: boolean;
    readonly scanSchedule: string;
  };
  readonly datasets: {
    readonly prefevalDietaryCount: number;
    readonly prefevalWorkCount: number;
    readonly halumemProfilesCount: number;
  };
  readonly generatedFiles: {
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
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly queryResults: readonly QueryResult[];
  readonly knownGapResults: readonly QueryResult[];
  readonly graph: {
    readonly passed: boolean;
    readonly failures: readonly string[];
    readonly nodeCount: number;
    readonly edgeCount: number;
  };
  readonly clarifications: {
    readonly total: number;
    readonly byType: Record<string, number>;
  };
  readonly passed: boolean;
}

interface PrefEvalRow {
  readonly preference: string;
  readonly question: string;
  readonly explanation?: string;
}

interface HaluMemProfile {
  readonly profile: {
    readonly fixed: {
      readonly basic_info: {
        readonly name: string;
        readonly location?: string;
      };
      readonly education?: {
        readonly highest_degree?: string;
        readonly major?: string;
      };
      readonly life_goal?: {
        readonly statement?: string;
      };
    };
    readonly dynamic: {
      readonly career_status?: {
        readonly company_name?: string;
        readonly job_title?: string;
      };
      readonly social_relationships?: Record<string, { readonly relationship_type?: string; readonly description?: string }>;
    };
    readonly preferences?: Record<
      string,
      {
        readonly memory_points?: Array<{
          readonly type?: string;
          readonly specific_item?: string;
          readonly reason?: string;
        }>;
      }
    >;
  };
}

function toThirdPersonPreference(name: string, text: string): string {
  let converted = text.trim();
  const replacements: Array<[RegExp, string]> = [
    [/^I'm\b/i, `${name} is`],
    [/^I am\b/i, `${name} is`],
    [/^I follow\b/i, `${name} follows`],
    [/^I have\b/i, `${name} has`],
    [/^I adhere\b/i, `${name} adheres`],
    [/^I avoid\b/i, `${name} avoids`],
    [/^I strongly dislike\b/i, `${name} strongly dislikes`],
    [/^I dislike\b/i, `${name} dislikes`],
    [/^I do not like\b/i, `${name} does not like`],
    [/^I prefer\b/i, `${name} prefers`],
    [/^I only consume\b/i, `${name} only consumes`],
    [/^I strictly avoid\b/i, `${name} strictly avoids`],
    [/^I have a strong aversion to\b/i, `${name} has a strong aversion to`]
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(converted)) {
      converted = converted.replace(pattern, replacement);
      break;
    }
  }
  if (!converted.startsWith(name)) {
    converted = `${name} says: ${converted}`;
  }
  return converted;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function localBrainRoot(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(localBrainRoot(), "benchmark-results");
}

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "public-dataset-watch");
}

function normalizedRoot(): string {
  return path.join(generatedRoot(), "normalized");
}

function rawRoot(): string {
  return path.join(generatedRoot(), "raw");
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
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

function downloadText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`request failed for ${url}: ${response.statusCode}`));
        response.resume();
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function downloadCached(url: string, fileName: string): Promise<string> {
  const destination = path.join(rawRoot(), fileName);
  try {
    return await readFile(destination, "utf8");
  } catch {
    const body = await downloadText(url);
    await writeFile(destination, body, "utf8");
    return body;
  }
}

function normalizeRelationshipName(value: string): string {
  const parts = value.match(/[A-Z][a-z]+/g) ?? [value];
  if (parts.length >= 2) {
    return `${parts.slice(1).join(" ")} ${parts[0]}`;
  }
  return value;
}

function collectText(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => collectText(item)).join("\n");
  }
  if (typeof payload === "object") {
    return Object.values(payload as Record<string, unknown>).map((item) => collectText(item)).join("\n");
  }
  return String(payload);
}

function pickPreferenceItems(profile: HaluMemProfile, category: string, count = 2): string[] {
  return (profile.profile.preferences?.[category]?.memory_points ?? [])
    .slice(0, count)
    .map((item) => {
      const sentiment = item.type?.includes("dislike") ? "dislikes" : "likes";
      return `${sentiment} ${item.specific_item ?? "unknown"}`;
    });
}

function buildPreferenceSentences(person: string, categoryLabel: string, items: readonly string[]): string {
  if (items.length === 0) {
    return `${person} has no ${categoryLabel.toLowerCase()} notes in this slice.`;
  }
  return items
    .map((item) => `${categoryLabel}: ${person} ${item}.`)
    .join(" ");
}

async function buildCorpus(): Promise<{
  readonly rootPath: string;
  readonly markdownFiles: number;
  readonly ignoredFiles: readonly string[];
  readonly datasets: PublicDatasetWatchReport["datasets"];
}> {
  await rm(generatedRoot(), { recursive: true, force: true });
  await mkdir(normalizedRoot(), { recursive: true });
  await mkdir(rawRoot(), { recursive: true });

  const [prefevalDietaryText, prefevalWorkText, halumemText] = await Promise.all([
    downloadCached(
      "https://raw.githubusercontent.com/amazon-science/PrefEval/main/benchmark_dataset/explicit_preference/lifestyle_dietary.json",
      "prefeval-lifestyle-dietary.json"
    ),
    downloadCached(
      "https://raw.githubusercontent.com/amazon-science/PrefEval/main/benchmark_dataset/explicit_preference/professional_work_location_style.json",
      "prefeval-professional-work-location-style.json"
    ),
    downloadCached(
      "https://raw.githubusercontent.com/MemTensor/HaluMem/main/data/stage1_3_preferences.jsonl",
      "halumem-stage1_3_preferences.jsonl"
    )
  ]);

  const prefevalDietary = JSON.parse(prefevalDietaryText) as PrefEvalRow[];
  const prefevalWork = JSON.parse(prefevalWorkText) as PrefEvalRow[];
  const halumemProfiles = halumemText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 6)
    .map((line) => JSON.parse(line) as HaluMemProfile);

  const notes: Array<{ readonly relativePath: string; readonly body: string }> = [];

  const prefevalPeople = [
    {
      name: "Avery Rivera",
      dietary: prefevalDietary[0],
      work: prefevalWork[0]
    },
    {
      name: "Jordan Lee",
      dietary: prefevalDietary[1],
      work: prefevalWork[1]
    },
    {
      name: "Maya Chen",
      dietary: prefevalDietary[2],
      work: prefevalWork[2]
    }
  ] as const;

  prefevalPeople.forEach((person, index) => {
    notes.push({
      relativePath: `2026/02/${String(index + 1).padStart(2, "0")}/2026-02-${String(index + 1).padStart(2, "0")}T09-00-00Z__prefeval__diet.md`,
      body: `# PrefEval Dietary Preference\n\n${toThirdPersonPreference(person.name, person.dietary.preference)}\n\nThe prompt used in the public benchmark was: ${person.dietary.question}\n`
    });
    notes.push({
      relativePath: `2026/02/${String(index + 1).padStart(2, "0")}/2026-02-${String(index + 1).padStart(2, "0")}T11-30-00Z__prefeval__work.md`,
      body: `# PrefEval Work And Location Preference\n\n${toThirdPersonPreference(person.name, person.work.preference)}\n\nThe prompt used in the public benchmark was: ${person.work.question}\n`
    });
  });

  halumemProfiles.forEach((profile, index) => {
    const person = profile.profile.fixed.basic_info.name;
    const location = profile.profile.fixed.basic_info.location ?? "unknown";
    const degree = profile.profile.fixed.education?.highest_degree ?? "unknown degree";
    const major = profile.profile.fixed.education?.major ?? "unknown field";
    const company = profile.profile.dynamic.career_status?.company_name ?? "unknown company";
    const role = profile.profile.dynamic.career_status?.job_title ?? "unknown role";
    const lifeGoal = profile.profile.fixed.life_goal?.statement ?? "unknown life goal";
    const relationships = Object.entries(profile.profile.dynamic.social_relationships ?? {})
      .slice(0, 3)
      .map(([rawName, relation]) => {
        const normalized = normalizeRelationshipName(rawName);
        const predicate = (relation.relationship_type ?? "relationship").toLowerCase();
        if (predicate === "friend") {
          return `${person} is friends with ${normalized}. ${normalized} is a close friend of ${person}. ${relation.description ?? ""}`.trim();
        }
        if (predicate === "colleague") {
          return `${person} works closely with ${normalized}. ${normalized} is a colleague of ${person}. ${relation.description ?? ""}`.trim();
        }
        return `${person} is connected to ${normalized}. ${normalized} is ${person}'s ${predicate}. ${relation.description ?? ""}`.trim();
      });

    const travelPreferences = pickPreferenceItems(profile, "Travel Preference", 5);
    const moviePreferences = pickPreferenceItems(profile, "Movie Preference", 5);
    const beveragePreferences = pickPreferenceItems(profile, "Beverage Preference");

    notes.push({
      relativePath: `2026/01/${String(index + 5).padStart(2, "0")}/2026-01-${String(index + 5).padStart(2, "0")}T08-00-00Z__halumem__profile.md`,
      body: `# HaluMem Profile\n\n${person} lives in ${location}. ${person} studied ${major} and holds a ${degree}. ${person} works at ${company} as a ${role}. ${person}'s current life goal is: ${lifeGoal}\n`
    });
    notes.push({
      relativePath: `2026/01/${String(index + 5).padStart(2, "0")}/2026-01-${String(index + 5).padStart(2, "0")}T09-15-00Z__halumem__relationships.md`,
      body: `# HaluMem Relationships\n\n${relationships.join("\n\n")}\n`
    });
    notes.push({
      relativePath: `2026/01/${String(index + 5).padStart(2, "0")}/2026-01-${String(index + 5).padStart(2, "0")}T10-45-00Z__halumem__preferences.md`,
      body: `# HaluMem Preferences\n\n${buildPreferenceSentences(person, "Travel Preference", travelPreferences)}\n\n${buildPreferenceSentences(person, "Movie Preference", moviePreferences)}\n\n${buildPreferenceSentences(person, "Beverage Preference", beveragePreferences)}\n`
    });
  });

  for (const note of notes) {
    await mkdir(path.dirname(path.join(normalizedRoot(), note.relativePath)), { recursive: true });
    await writeFile(path.join(normalizedRoot(), note.relativePath), note.body, "utf8");
  }

  const ignoredFiles = [".DS_Store", "2026/.DS_Store"];
  for (const file of ignoredFiles) {
    await writeFile(path.join(normalizedRoot(), file), "", "utf8");
  }

  return {
    rootPath: normalizedRoot(),
    markdownFiles: notes.length,
    ignoredFiles,
    datasets: {
      prefevalDietaryCount: prefevalPeople.length,
      prefevalWorkCount: prefevalPeople.length,
      halumemProfilesCount: halumemProfiles.length
    }
  };
}

async function ensureSource(namespaceId: string, rootPath: string) {
  const existing = (await listMonitoredSources(100)).filter((source) => source.namespaceId === namespaceId);
  for (const source of existing) {
    await deleteMonitoredSource(source.id);
  }
  return createMonitoredSource({
    sourceType: "folder",
    namespaceId,
    label: "Public Dataset Watch",
    rootPath,
    includeSubfolders: true,
    monitorEnabled: true,
    scanSchedule: "every_30_minutes",
    notes: "Public PrefEval and HaluMem watched-folder benchmark corpus.",
    metadata: {
      source_intent: "ongoing_folder_monitor",
      producer: "public_dataset_benchmark",
      smoke_test: true
    }
  });
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
  await runCandidateConsolidation(namespaceId);
  await runRelationshipAdjudication(namespaceId);
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, { layer, lookbackDays: 365 });
  }
  await runTemporalNodeArchival(namespaceId);
  await executeProvenanceAuditWorker();
}

function querySpecs(namespaceId: string): readonly QuerySpec[] {
  return [
    {
      name: "martin_friend_relationships",
      mode: "mcp_relationships",
      entityName: "Martin Mark",
      expectedTerms: ["Susan Thomas"],
      minimumConfidence: "confident"
    },
    {
      name: "donna_location",
      mode: "mcp_search",
      query: "where does Donna Gonzalez live?",
      expectedTerms: ["San Diego"],
      minimumConfidence: "weak"
    },
    {
      name: "donna_friend_relationships",
      mode: "mcp_relationships",
      entityName: "Donna Gonzalez",
      expectedTerms: ["Mary Brown", "Paul Lopez"],
      minimumConfidence: "confident"
    },
    {
      name: "susan_relationships",
      mode: "search",
      query: "who are Susan Thompson's friends?",
      expectedTerms: ["Linda Martinez", "Joseph Lopez"],
      minimumConfidence: "confident"
    },
    {
      name: "avery_diet",
      mode: "mcp_search",
      query: "what diet does Avery Rivera follow?",
      expectedTerms: ["gluten-free", "dairy-free"],
      minimumConfidence: "weak"
    },
    {
      name: "martin_travel_styles",
      mode: "mcp_search",
      query: "what travel does Martin Mark prefer?",
      expectedTerms: ["Wellness retreats", "Nature hikes"],
      minimumConfidence: "weak"
    },
    {
      name: "barbara_travel_styles",
      mode: "mcp_search",
      query: "what travel does Barbara Jones prefer?",
      expectedTerms: ["Visiting places with rich scientific history", "Wellness retreats"],
      minimumConfidence: "weak"
    },
    {
      name: "steven_preference_mix",
      mode: "mcp_search",
      query: "what beverages does Steven Miller like?",
      expectedTerms: ["Cold brew coffee", "Green tea"],
      minimumConfidence: "weak"
    },
    {
      name: "martin_location_gap",
      mode: "mcp_search",
      query: "where does Martin Mark live?",
      expectedTerms: ["Columbus"],
      minimumConfidence: "weak",
      knownGap: true
    },
    {
      name: "martin_colleague_relationship_gap",
      mode: "mcp_relationships",
      entityName: "Martin Mark",
      expectedTerms: ["Susan Thomas", "Daniel Martinez"],
      minimumConfidence: "confident",
      knownGap: true
    },
    {
      name: "martin_travel_preferences_gap",
      mode: "mcp_search",
      query: "what travel does Martin Mark prefer?",
      expectedTerms: ["Wellness retreats", "Nature hikes"],
      minimumConfidence: "weak",
      knownGap: true
    },
    {
      name: "donna_full_relationship_gap",
      mode: "mcp_relationships",
      entityName: "Donna Gonzalez",
      expectedTerms: ["Anthony Martinez", "Mary Brown"],
      minimumConfidence: "confident",
      knownGap: true
    },
    {
      name: "johnson_movie_dislikes_gap",
      mode: "mcp_search",
      query: "what movies does Johnson Joseph dislike?",
      expectedTerms: ["Horror films", "Science fiction"],
      minimumConfidence: "weak",
      knownGap: true
    },
    {
      name: "jordan_location_aversion_gap",
      mode: "mcp_search",
      query: "what kind of places does Jordan Lee avoid living in?",
      expectedTerms: ["hot and humid", "living"],
      minimumConfidence: "weak",
      knownGap: true
    },
    {
      name: "maya_city_noise_gap",
      mode: "mcp_search",
      query: "what kind of neighborhood does Maya Chen dislike?",
      expectedTerms: ["high-density urban areas", "noise"],
      minimumConfidence: "weak",
      knownGap: true
    }
  ];
}

async function runQuery(namespaceId: string, spec: QuerySpec): Promise<QueryResult> {
  const startedAt = performance.now();
  let confidence: Confidence | null = null;
  let joined = "";

  if (spec.mode === "search") {
    const result = await searchMemory({
      namespaceId,
      query: spec.query ?? "",
      limit: 8
    });
    confidence = (result.meta.answerAssessment?.confidence ?? "missing") as Confidence;
    joined = `${result.duality.claim.text ?? ""}\n${result.results.map((item) => item.content).join("\n")}\n${result.evidence.map((item) => item.snippet).join("\n")}`;
  } else if (spec.mode === "mcp_search") {
    const wrapped = (await executeMcpTool("memory.search", {
      namespace_id: namespaceId,
      query: spec.query,
      limit: 8
    })) as { readonly structuredContent?: unknown };
    const payload = wrapped.structuredContent as { readonly duality?: { readonly confidence?: Confidence } } | undefined;
    confidence = payload?.duality?.confidence ?? "missing";
    joined = collectText(wrapped.structuredContent);
  } else {
    const wrapped = (await executeMcpTool("memory.get_relationships", {
      namespace_id: namespaceId,
      entity_name: spec.entityName,
      limit: 20
    })) as { readonly structuredContent?: unknown };
    confidence = "confident";
    joined = collectText(wrapped.structuredContent);
  }

  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const failures: string[] = [];
  const lowerJoined = joined.toLowerCase();

  for (const expected of spec.expectedTerms) {
    if (!lowerJoined.includes(expected.toLowerCase())) {
      failures.push(`missing term ${expected}`);
    }
  }

  if (spec.minimumConfidence && confidence && confidenceRank(confidence) < confidenceRank(spec.minimumConfidence)) {
    failures.push(`confidence ${confidence} below ${spec.minimumConfidence}`);
  }

  return {
    name: spec.name,
    mode: spec.mode,
    latencyMs,
    confidence,
    passed: failures.length === 0,
    failures
  };
}

async function runGraphCheck(namespaceId: string): Promise<PublicDatasetWatchReport["graph"]> {
  const graph = await getOpsRelationshipGraph(namespaceId, {
    entityName: "Martin Mark",
    limit: 24
  });
  const names = graph.nodes.map((node) => node.name.toLowerCase());
  const failures: string[] = [];
  for (const expected of ["susan thomas"]) {
    if (!names.includes(expected)) {
      failures.push(`missing graph node ${expected}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length
  };
}

function toMarkdown(report: PublicDatasetWatchReport): string {
  const lines = [
    "# Public Dataset Watch Benchmark",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- passed: ${report.passed}`,
    "",
    "## Dataset Mix",
    "",
    `- PrefEval dietary personas: ${report.datasets.prefevalDietaryCount}`,
    `- PrefEval work-location personas: ${report.datasets.prefevalWorkCount}`,
    `- HaluMem profiles: ${report.datasets.halumemProfilesCount}`,
    "",
    "## Import",
    "",
    `- markdown files: ${report.generatedFiles.markdownFiles}`,
    `- import status: ${report.importRun.status}`,
    `- attempted/imported/failed: ${report.importRun.filesAttempted}/${report.importRun.filesImported}/${report.importRun.filesFailed}`,
    "",
    "## Latency",
    "",
    `- p50: ${report.latency.p50Ms}ms`,
    `- p95: ${report.latency.p95Ms}ms`,
    `- max: ${report.latency.maxMs}ms`,
    "",
    "## Queries",
    ""
  ];

  for (const result of report.queryResults) {
    lines.push(`- ${result.name}: ${result.passed ? "pass" : "fail"} | mode=${result.mode} | confidence=${result.confidence ?? "n/a"} | latency=${result.latencyMs}ms`);
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("", "## Known Gaps", "");
  for (const result of report.knownGapResults) {
    lines.push(`- ${result.name}: ${result.passed ? "pass" : "gap"} | mode=${result.mode} | confidence=${result.confidence ?? "n/a"} | latency=${result.latencyMs}ms`);
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runPublicDatasetWatchBenchmark(
  namespaceId = "public_dataset_watch"
): Promise<PublicDatasetWatchReport> {
  return withMaintenanceLock("the public dataset watched-folder benchmark", async () => {
    await runMigrations();
    const generated = await buildCorpus();
    await upsertNamespaceSelfProfile({
      namespaceId,
      canonicalName: "Martin Mark",
      aliases: ["Martin"],
      note: "Public dataset benchmark self anchor."
    });

    const source = await ensureSource(namespaceId, generated.rootPath);
    const firstScan = await scanMonitoredSource(source.id);
    const importResult = await importMonitoredSource(source.id, "onboarding");
    await rebuildNamespace(namespaceId);
    const scheduled = await processScheduledMonitoredSources({
      sourceId: source.id,
      now: new Date(Date.now() + 31 * 60 * 1000),
      importAfterScan: true
    });

    const queryResults: QueryResult[] = [];
    const knownGapResults: QueryResult[] = [];
    for (const spec of querySpecs(namespaceId)) {
      const result = await runQuery(namespaceId, spec);
      if (spec.knownGap) {
        knownGapResults.push(result);
      } else {
        queryResults.push(result);
      }
    }

    const graph = await runGraphCheck(namespaceId);
    const clarifications = await getOpsClarificationInbox(namespaceId, 20);
    const latencyValues = queryResults.map((item) => item.latencyMs);

    return {
      generatedAt: new Date().toISOString(),
      namespaceId,
      source: {
        id: source.id,
        rootPath: source.rootPath,
        monitorEnabled: source.monitorEnabled,
        scanSchedule: source.scanSchedule
      },
      datasets: generated.datasets,
      generatedFiles: {
        markdownFiles: generated.markdownFiles,
        ignoredFiles: generated.ignoredFiles
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
      latency: {
        p50Ms: percentile(latencyValues, 50),
        p95Ms: percentile(latencyValues, 95),
        maxMs: Number(Math.max(...latencyValues, 0).toFixed(2))
      },
      queryResults,
      knownGapResults,
      graph,
      clarifications: {
        total: clarifications.summary.total,
        byType: clarifications.summary.byType
      },
      passed:
        firstScan.preview.totalFiles >= generated.markdownFiles &&
        (importResult.importRun?.filesImported ?? 0) >= generated.markdownFiles &&
        scheduled.processedCount >= 1 &&
        queryResults.every((item) => item.passed) &&
        graph.passed
    };
  });
}

export async function runAndWritePublicDatasetWatchBenchmark(): Promise<{
  readonly report: PublicDatasetWatchReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runPublicDatasetWatchBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `public-dataset-watch-${stamp}.json`);
    const markdownPath = path.join(dir, `public-dataset-watch-${stamp}.md`);
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

export async function runPublicDatasetWatchBenchmarkCli(): Promise<void> {
  const result = await runAndWritePublicDatasetWatchBenchmark();
  console.log(JSON.stringify(result, null, 2));
}
