import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { searchMemory } from "../retrieval/service.js";
import { loadNarrativeBenchmarkCases, type LoadedNarrativeBenchmarkCase } from "./narrative-cases.js";

interface NarrativeCaseResult {
  readonly name: string;
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly scores: {
    readonly entity_presence: number;
    readonly graph_recall: number;
    readonly graph_precision: number;
    readonly current_truth_accuracy: number;
    readonly search_recall: number;
  };
  readonly failures: readonly string[];
}

export interface NarrativeBenchmarkReport {
  readonly generatedAt: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly cases: readonly NarrativeCaseResult[];
  readonly recommendation: "ready_for_more_story_types" | "needs_extraction_fixups";
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultOutputDir(): string {
  return path.resolve(thisDir(), "../../benchmark-results");
}

function ratio(hit: number, total: number): number {
  if (total <= 0) {
    return 1;
  }
  return Math.round((hit / total) * 1000) / 1000;
}

async function seedCase(loaded: LoadedNarrativeBenchmarkCase, namespaceId: string): Promise<void> {
  for (const file of loaded.definition.files) {
    await ingestArtifact({
      inputUri: path.join(loaded.directory, file.path),
      namespaceId,
      sourceType: file.source_type,
      sourceChannel: file.source_channel,
      capturedAt: file.captured_at ?? new Date().toISOString()
    });
  }

  await runRelationshipAdjudication(namespaceId, {
    limit: 400,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  await runCandidateConsolidation(namespaceId, 400);

  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, {
      layer,
      lookbackDays: 2000,
      maxMembersPerNode: 1000
    });
  }
}

async function entityNames(namespaceId: string): Promise<Set<string>> {
  const rows = await queryRows<{ canonical_name: string }>(
    `SELECT canonical_name FROM entities WHERE namespace_id = $1`,
    [namespaceId]
  );
  return new Set(rows.map((row) => row.canonical_name));
}

async function entityPresenceScore(loaded: LoadedNarrativeBenchmarkCase, namespaceId: string, failures: string[]): Promise<number> {
  const names = await entityNames(namespaceId);
  let hits = 0;
  for (const expected of loaded.definition.expected.entities_present ?? []) {
    if (names.has(expected.name)) {
      hits += 1;
    } else {
      failures.push(`missing entity: ${expected.name}`);
    }
  }

  for (const forbidden of loaded.definition.expected.entities_absent ?? []) {
    if (names.has(forbidden)) {
      failures.push(`unexpected entity: ${forbidden}`);
    }
  }

  return ratio(hits, loaded.definition.expected.entities_present?.length ?? 0);
}

async function graphScores(loaded: LoadedNarrativeBenchmarkCase, namespaceId: string, failures: string[]): Promise<{ recall: number; precision: number }> {
  const rows = await queryRows<{ subject_name: string; predicate: string; object_name: string }>(
    `
      SELECT subject.canonical_name AS subject_name, rm.predicate, object_entity.canonical_name AS object_name
      FROM relationship_memory rm
      JOIN entities subject ON subject.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = $1
        AND rm.status = 'active'
    `,
    [namespaceId]
  );

  const edgeSet = new Set(rows.map((row) => `${row.subject_name}|${row.predicate}|${row.object_name}`));
  let presentHits = 0;
  for (const edge of loaded.definition.expected.graph_edges_present ?? []) {
    const key = `${edge.subject}|${edge.predicate}|${edge.object}`;
    if (edgeSet.has(key)) {
      presentHits += 1;
    } else {
      failures.push(`missing edge: ${key}`);
    }
  }

  let absentHits = 0;
  for (const edge of loaded.definition.expected.graph_edges_absent ?? []) {
    const key = `${edge.subject}|${edge.predicate}|${edge.object}`;
    if (!edgeSet.has(key)) {
      absentHits += 1;
    } else {
      failures.push(`unexpected edge: ${key}`);
    }
  }

  return {
    recall: ratio(presentHits, loaded.definition.expected.graph_edges_present?.length ?? 0),
    precision: ratio(absentHits, loaded.definition.expected.graph_edges_absent?.length ?? 0)
  };
}

async function proceduralScore(loaded: LoadedNarrativeBenchmarkCase, namespaceId: string, failures: string[]): Promise<number> {
  const expectations = loaded.definition.expected.procedural_states ?? [];
  if (expectations.length === 0) {
    return 1;
  }

  let hits = 0;
  for (const expected of expectations) {
    const rows = await queryRows<{ state_value: Record<string, unknown> }>(
      `
        SELECT state_value
        FROM procedural_memory
        WHERE namespace_id = $1
          AND state_type = $2
          AND state_key = $3
          AND valid_until IS NULL
        ORDER BY version DESC
        LIMIT 1
      `,
      [namespaceId, expected.state_type, expected.state_key]
    );

    const value = rows[0]?.state_value?.[expected.field];
    if (value === expected.equals) {
      hits += 1;
    } else {
      failures.push(`procedural mismatch: ${expected.state_type}/${expected.state_key}.${expected.field} expected ${expected.equals}, got ${String(value ?? "null")}`);
    }
  }

  return ratio(hits, expectations.length);
}

async function searchScore(loaded: LoadedNarrativeBenchmarkCase, namespaceId: string, failures: string[]): Promise<number> {
  const queries = loaded.definition.queries ?? [];
  if (queries.length === 0) {
    return 1;
  }

  let hits = 0;
  for (const query of queries) {
    const result = await searchMemory({
      namespaceId,
      query: query.query,
      timeStart: query.time_start,
      timeEnd: query.time_end,
      limit: 5
    });
    const candidateResults = result.results.slice(0, 3);
    const top = candidateResults[0];
    const aggregatedContent = candidateResults.map((item) => item.content).join(" \n ").toLowerCase();
    const typeOk =
      !query.expect_top_types || candidateResults.some((item) => query.expect_top_types?.includes(item.memoryType));
    const contentOk =
      !query.expect_top_includes ||
      query.expect_top_includes.every((term) => aggregatedContent.includes(term.toLowerCase()));

    if (top && typeOk && contentOk) {
      hits += 1;
    } else {
      failures.push(`search miss: ${query.name}`);
    }
  }

  return ratio(hits, queries.length);
}

async function runCase(loaded: LoadedNarrativeBenchmarkCase): Promise<NarrativeCaseResult> {
  const namespaceId = `narrative_${loaded.definition.namespace_seed}_${Date.now().toString(36)}`;
  await seedCase(loaded, namespaceId);

  const failures: string[] = [];
  const entityScore = await entityPresenceScore(loaded, namespaceId, failures);
  const graph = await graphScores(loaded, namespaceId, failures);
  const procedural = await proceduralScore(loaded, namespaceId, failures);
  const search = await searchScore(loaded, namespaceId, failures);

  return {
    name: loaded.definition.name,
    namespaceId,
    passed: failures.length === 0,
    scores: {
      entity_presence: entityScore,
      graph_recall: graph.recall,
      graph_precision: graph.precision,
      current_truth_accuracy: procedural,
      search_recall: search
    },
    failures
  };
}

function toMarkdown(report: NarrativeBenchmarkReport): string {
  const lines: string[] = [
    "# Narrative Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Passed: ${report.passedCases}/${report.totalCases}`,
    `Recommendation: ${report.recommendation}`,
    ""
  ];

  for (const item of report.cases) {
    lines.push(`## ${item.name}`);
    lines.push(`- Namespace: ${item.namespaceId}`);
    lines.push(`- Passed: ${item.passed}`);
    lines.push(`- Entity presence: ${item.scores.entity_presence}`);
    lines.push(`- Graph recall: ${item.scores.graph_recall}`);
    lines.push(`- Graph precision: ${item.scores.graph_precision}`);
    lines.push(`- Current truth accuracy: ${item.scores.current_truth_accuracy}`);
    lines.push(`- Search recall: ${item.scores.search_recall}`);
    if (item.failures.length > 0) {
      lines.push(`- Failures: ${item.failures.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runNarrativeBenchmark(): Promise<NarrativeBenchmarkReport> {
  const cases = await loadNarrativeBenchmarkCases();
  const results: NarrativeCaseResult[] = [];

  for (const loaded of cases) {
    results.push(await runCase(loaded));
  }

  const passedCases = results.filter((item) => item.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    cases: results,
    recommendation: passedCases === results.length ? "ready_for_more_story_types" : "needs_extraction_fixups"
  };
}

export async function writeNarrativeBenchmarkReport(report: NarrativeBenchmarkReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const outputDir = defaultOutputDir();
  await mkdir(outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `narrative-benchmark-${stamp}.json`);
  const markdownPath = path.join(outputDir, `narrative-benchmark-${stamp}.md`);
  const markdown = toMarkdown(report);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(path.join(outputDir, "narrative-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "narrative-latest.md"), markdown, "utf8");
  return { jsonPath, markdownPath };
}

export async function runAndWriteNarrativeBenchmark(): Promise<{
  readonly report: NarrativeBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runNarrativeBenchmark();
    const output = await writeNarrativeBenchmarkReport(report);
    return { report, output };
  } finally {
    await closePool();
  }
}
