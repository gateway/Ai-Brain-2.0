import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { getOpsRelationshipGraph } from "../ops/service.js";
import { searchMemory } from "../retrieval/service.js";
import { resetDatabase, runLifeReplayBenchmark, seedNamespace } from "./life-replay.js";

interface ScaleQuerySpec {
  readonly name: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly minimumConfidence: "confident" | "weak" | "missing";
  readonly expectedFollowUpAction?: "none" | "suggest_verification" | "route_to_clarifications";
}

interface ScaleQueryResult {
  readonly name: string;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: "confident" | "weak" | "missing";
  readonly followUpAction: string | null;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface ScaleGraphResult {
  readonly name: string;
  readonly passed: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly failures: readonly string[];
}

export interface LifeScaleBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly baseline: {
    readonly confidentCount: number;
    readonly weakCount: number;
    readonly missingCount: number;
    readonly passed: boolean;
    readonly pack: {
      readonly confidentCount: number;
      readonly weakCount: number;
      readonly missingCount: number;
    };
  };
  readonly generatedArtifacts: {
    readonly medium: number;
    readonly large: number;
    readonly noisy: number;
    readonly total: number;
  };
  readonly clarificationCounts: Record<string, number>;
  readonly graphResults: readonly ScaleGraphResult[];
  readonly queryResults: readonly ScaleQueryResult[];
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly quality: {
    readonly confidentCount: number;
    readonly weakCount: number;
    readonly missingCount: number;
  };
  readonly qualityDelta: {
    readonly confidentDelta: number;
    readonly weakDelta: number;
    readonly missingDelta: number;
  };
  readonly passed: boolean;
}

interface GeneratedArtifact {
  readonly path: string;
  readonly sourceChannel: string;
  readonly capturedAt: string;
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

function generatedFixtureRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "life-scale");
}

function confidenceRank(value: "confident" | "weak" | "missing"): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function isoAt(dayOffset: number, hour = 9): string {
  const date = new Date(Date.UTC(2026, 3, 1 + dayOffset, hour, 0, 0));
  return date.toISOString();
}

function buildMediumFile(fileIndex: number, entryCount: number): string {
  const companions = ["Gummi", "Dan", "Ben", "Lauren", "Tim", "Maya", "Kiko", "Jonas"];
  const places = ["Yellow co-working space", "Chiang Mai", "Lake Tahoe", "Bend, Oregon", "Koh Samui"];
  const projects = ["Two-Way", "Well Inked", "Photo Club", "AI Brain"];
  const lines = [`# Medium Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const companion = companions[(fileIndex + index) % companions.length];
    const place = places[(fileIndex * 3 + index) % places.length];
    const project = projects[(fileIndex * 5 + index) % projects.length];
    lines.push(
      `On April ${(index % 28) + 1}, 2026 Steve spent the morning at ${place} with ${companion} and worked on ${project}. Later he reviewed the relationship graph, place hierarchy, and current truth around Chiang Mai, Thailand.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildLargeFile(fileIndex: number, entryCount: number): string {
  const companions = ["Dan", "Gummi", "Ben", "Lauren", "Tim", "Maya", "Kiko", "Jonas", "Priya", "Nia", "Tessa", "Leo"];
  const places = [
    "Yellow co-working space in Chiang Mai, Thailand",
    "Tahoe City in Lake Tahoe, California",
    "Bend, Oregon",
    "Koh Samui, Thailand",
    "Mexico City, Mexico",
    "Munich, Germany"
  ];
  const orgs = ["Two-Way", "Well Inked", "Photo Club", "The Samui Experience"];
  const lines = [`# Large Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const companion = companions[(fileIndex + index) % companions.length];
    const secondary = companions[(fileIndex + index + 4) % companions.length];
    const place = places[(fileIndex * 7 + index) % places.length];
    const org = orgs[(fileIndex * 2 + index) % orgs.length];
    lines.push(
      `On May ${(index % 28) + 1}, 2026 Steve met ${companion} and ${secondary} at ${place}. They talked about ${org}, the social graph, current employer truth, and how place containment should expand from city to country without inventing new residence facts.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildNoisyFile(fileIndex: number, entryCount: number): string {
  const aliasVariants = ["Gumee", "Gumi", "Stephan", "Stephen Tietze"];
  const vaguePlaces = ["the summer cabin", "the old house by the beach", "the London building south wing", "the cabin near the lake"];
  const nearDuplicateProjects = ["Tokyo Research", "The Tokyo Project", "Project Tokyo", "Tokyo Research Packet"];
  const lines = [`# Noisy Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const alias = aliasVariants[(fileIndex + index) % aliasVariants.length];
    const vaguePlace = vaguePlaces[(fileIndex * 3 + index) % vaguePlaces.length];
    const project = nearDuplicateProjects[(fileIndex * 5 + index) % nearDuplicateProjects.length];
    lines.push(
      `Uncle said ${alias} left the notes for ${project} at ${vaguePlace}. Later Dad asked whether ${project} was the same as Tokyo Research, but nobody clarified which person or place they meant.`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function writeGeneratedArtifacts(): Promise<{
  readonly medium: readonly GeneratedArtifact[];
  readonly large: readonly GeneratedArtifact[];
  readonly noisy: readonly GeneratedArtifact[];
}> {
  const root = generatedFixtureRoot();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const medium: GeneratedArtifact[] = [];
  const large: GeneratedArtifact[] = [];
  const noisy: GeneratedArtifact[] = [];

  for (let index = 0; index < 20; index += 1) {
    const filePath = path.join(root, `medium-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildMediumFile(index, 60), "utf8");
    medium.push({
      path: filePath,
      sourceChannel: `life-scale:medium:${index + 1}`,
      capturedAt: isoAt(index)
    });
  }

  for (let index = 0; index < 48; index += 1) {
    const filePath = path.join(root, `large-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildLargeFile(index, 90), "utf8");
    large.push({
      path: filePath,
      sourceChannel: `life-scale:large:${index + 1}`,
      capturedAt: isoAt(index, 13)
    });
  }

  for (let index = 0; index < 18; index += 1) {
    const filePath = path.join(root, `noisy-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildNoisyFile(index, 50), "utf8");
    noisy.push({
      path: filePath,
      sourceChannel: `life-scale:noisy:${index + 1}`,
      capturedAt: isoAt(index, 18)
    });
  }

  return { medium, large, noisy };
}

async function ingestGeneratedArtifacts(namespaceId: string, artifacts: readonly GeneratedArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    await ingestArtifact({
      inputUri: artifact.path,
      namespaceId,
      sourceType: "markdown",
      sourceChannel: artifact.sourceChannel,
      capturedAt: artifact.capturedAt
    });
  }
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
  await runRelationshipAdjudication(namespaceId, {
    limit: 2400,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  await runCandidateConsolidation(namespaceId, 2400);
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, {
      layer,
      lookbackDays: 6000,
      maxMembersPerNode: 512
    });
  }
}

const SCALE_QUERY_SPECS: readonly ScaleQuerySpec[] = [
  {
    name: "current_home",
    query: "where does Steve live?",
    expectedTerms: ["Chiang Mai"],
    minimumConfidence: "confident"
  },
  {
    name: "current_employer",
    query: "where does Steve work?",
    expectedTerms: ["Two-Way"],
    minimumConfidence: "confident"
  },
  {
    name: "friends",
    query: "who are Steve's friends?",
    expectedTerms: ["Dan", "Ben", "Lauren"],
    minimumConfidence: "confident"
  },
  {
    name: "current_project",
    query: "what is Steve working on?",
    expectedTerms: ["Two-Way"],
    minimumConfidence: "confident"
  },
  {
    name: "yellow_event",
    query: "what happened at Yellow co-working space?",
    expectedTerms: ["Yellow"],
    minimumConfidence: "confident"
  },
  {
    name: "uncle_clarification",
    query: "who is Uncle?",
    expectedTerms: [],
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications"
  },
  {
    name: "summer_cabin_clarification",
    query: "where was the summer cabin?",
    expectedTerms: [],
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications"
  }
];

async function runScaleQuery(namespaceId: string, spec: ScaleQuerySpec): Promise<ScaleQueryResult> {
  const start = performance.now();
  const result = await searchMemory({
    namespaceId,
    query: spec.query,
    limit: 8
  });
  const latencyMs = Number((performance.now() - start).toFixed(2));
  const joined = result.results.map((item) => item.content).join("\n").toLowerCase();
  const confidence = result.meta.answerAssessment?.confidence ?? "missing";
  const failures: string[] = [];

  for (const expected of spec.expectedTerms) {
    if (!joined.includes(expected.toLowerCase()) && !String(result.duality.claim.text ?? "").toLowerCase().includes(expected.toLowerCase())) {
      failures.push(`missing term ${expected}`);
    }
  }

  if (confidenceRank(confidence) < confidenceRank(spec.minimumConfidence)) {
    failures.push(`confidence ${confidence} below ${spec.minimumConfidence}`);
  }

  if (spec.expectedFollowUpAction && result.meta.followUpAction !== spec.expectedFollowUpAction) {
    failures.push(`expected follow-up action ${spec.expectedFollowUpAction}, got ${result.meta.followUpAction ?? "none"}`);
  }

  if (spec.expectedFollowUpAction === "route_to_clarifications") {
    const toolName = result.duality.clarificationHint?.mcpTool?.name ?? result.meta.clarificationHint?.mcpTool?.name;
    if (toolName !== "memory.get_clarifications") {
      failures.push(`expected clarification tool memory.get_clarifications, got ${toolName ?? "none"}`);
    }
  }

  return {
    name: spec.name,
    query: spec.query,
    latencyMs,
    confidence,
    followUpAction: result.meta.followUpAction ?? null,
    passed: failures.length === 0,
    failures
  };
}

async function clarificationCounts(namespaceId: string): Promise<Record<string, number>> {
  const rows = await queryRows<{ ambiguity_type: string | null; total: string }>(
    `
      SELECT ambiguity_type, COUNT(*)::text AS total
      FROM claim_candidates
      WHERE namespace_id = $1
        AND ambiguity_state = 'requires_clarification'
      GROUP BY ambiguity_type
      ORDER BY ambiguity_type
    `,
    [namespaceId]
  );
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.ambiguity_type ?? "unknown"] = Number(row.total);
  }
  return result;
}

async function runGraphStress(namespaceId: string): Promise<readonly ScaleGraphResult[]> {
  const steveGraph = await getOpsRelationshipGraph(namespaceId, {
    entityName: "Steve Tietze",
    limit: 160
  });

  const names = new Set(steveGraph.nodes.map((node) => node.name));
  const nodeText = steveGraph.nodes.map((node) => node.name).join("\n");
  const predicates = new Set(steveGraph.edges.map((edge) => edge.predicate));
  const failures: string[] = [];
  for (const term of ["Chiang Mai", "Thailand", "Lake Tahoe", "Two-Way", "Dan", "Lauren"]) {
    if (!names.has(term) && !nodeText.includes(term)) {
      failures.push(`missing node ${term}`);
    }
  }
  for (const predicate of ["contained_in", "resides_at", "worked_at", "friend_of", "participated_in"]) {
    if (!predicates.has(predicate)) {
      failures.push(`missing edge predicate ${predicate}`);
    }
  }
  if (steveGraph.nodes.length < 20) {
    failures.push(`node count too low: ${steveGraph.nodes.length}`);
  }
  if (steveGraph.edges.length < 20) {
    failures.push(`edge count too low: ${steveGraph.edges.length}`);
  }

  return [
    {
      name: "steve_focus_scale_graph",
      passed: failures.length === 0,
      nodeCount: steveGraph.nodes.length,
      edgeCount: steveGraph.edges.length,
      failures
    }
  ];
}

function toMarkdown(report: LifeScaleBenchmarkReport): string {
  const lines = [
    "# Life Scale Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Generated artifacts: ${report.generatedArtifacts.total} (medium=${report.generatedArtifacts.medium}, large=${report.generatedArtifacts.large}, noisy=${report.generatedArtifacts.noisy})`,
    `Baseline quality: confident=${report.baseline.confidentCount}, weak=${report.baseline.weakCount}, missing=${report.baseline.missingCount}`,
    `Baseline pack: confident=${report.baseline.pack.confidentCount}, weak=${report.baseline.pack.weakCount}, missing=${report.baseline.pack.missingCount}`,
    `Scale quality: confident=${report.quality.confidentCount}, weak=${report.quality.weakCount}, missing=${report.quality.missingCount}`,
    `Latency p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms max=${report.latency.maxMs}ms`,
    `Passed: ${report.passed}`,
    "",
    "## Query Results",
    ""
  ];

  for (const item of report.queryResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | confidence=${item.confidence} | latency=${item.latencyMs}ms`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Graph Results", "");
  for (const item of report.graphResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | nodes=${item.nodeCount} | edges=${item.edgeCount}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Clarifications", "", `\`${JSON.stringify(report.clarificationCounts, null, 2)}\``);
  return `${lines.join("\n")}\n`;
}

export async function runLifeScaleBenchmark(): Promise<LifeScaleBenchmarkReport> {
  const namespaceId = "personal";
  await runMigrations();
  const baseline = await runLifeReplayBenchmark();
  const baselineQueryResults: ScaleQueryResult[] = [];
  for (const spec of SCALE_QUERY_SPECS) {
    baselineQueryResults.push(await runScaleQuery(namespaceId, spec));
  }

  await resetDatabase();
  await seedNamespace(namespaceId);
  const generated = await writeGeneratedArtifacts();
  await ingestGeneratedArtifacts(namespaceId, [...generated.medium, ...generated.large, ...generated.noisy]);
  await rebuildNamespace(namespaceId);

  const queryResults: ScaleQueryResult[] = [];
  for (const spec of SCALE_QUERY_SPECS) {
    queryResults.push(await runScaleQuery(namespaceId, spec));
  }

  const graphResults = await runGraphStress(namespaceId);
  const clarifications = await clarificationCounts(namespaceId);
  const latencies = queryResults.map((item) => item.latencyMs);
  const confidentCount = queryResults.filter((item) => item.confidence === "confident").length;
  const weakCount = queryResults.filter((item) => item.confidence === "weak").length;
  const missingCount = queryResults.filter((item) => item.confidence === "missing").length;

  return {
    generatedAt: new Date().toISOString(),
    namespaceId,
    baseline: {
      confidentCount: baseline.confidentCount,
      weakCount: baseline.weakCount,
      missingCount: baseline.missingCount,
      passed: baseline.passed,
      pack: {
        confidentCount: baselineQueryResults.filter((item) => item.confidence === "confident").length,
        weakCount: baselineQueryResults.filter((item) => item.confidence === "weak").length,
        missingCount: baselineQueryResults.filter((item) => item.confidence === "missing").length
      }
    },
    generatedArtifacts: {
      medium: generated.medium.length,
      large: generated.large.length,
      noisy: generated.noisy.length,
      total: generated.medium.length + generated.large.length + generated.noisy.length
    },
    clarificationCounts: clarifications,
    graphResults,
    queryResults,
    latency: {
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      maxMs: percentile(latencies, 100)
    },
    quality: {
      confidentCount,
      weakCount,
      missingCount
    },
    qualityDelta: {
      confidentDelta: confidentCount - baselineQueryResults.filter((item) => item.confidence === "confident").length,
      weakDelta: weakCount - baselineQueryResults.filter((item) => item.confidence === "weak").length,
      missingDelta: missingCount - baselineQueryResults.filter((item) => item.confidence === "missing").length
    },
    passed: [...queryResults, ...graphResults].every((item) => item.passed)
  };
}

export async function runAndWriteLifeScaleBenchmark(): Promise<{
  readonly report: LifeScaleBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runLifeScaleBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `life-scale-${stamp}.json`);
    const markdownPath = path.join(dir, `life-scale-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    await writeFile(path.join(dir, "life-scale-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(dir, "life-scale-latest.md"), toMarkdown(report), "utf8");
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
