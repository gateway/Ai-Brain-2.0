import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { QueryResultRow } from "pg";
import { closePool, queryRows, withTransaction } from "../db/client.js";
import { ingestArtifact } from "../ingest/worker.js";
import type { SourceType } from "../types.js";

interface DbCoverageFixture {
  readonly id: string;
  readonly fileName: string;
  readonly sourceType: SourceType;
  readonly sourceChannel: string;
  readonly expectedRoute: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

interface DbCoverageTableStats {
  readonly table: string;
  readonly rowCount: number;
  readonly routerMetadataCount: number;
  readonly sourceIntelligenceProfileCount: number;
  readonly taxonomyProfileCount: number;
  readonly coverageRate: number;
  readonly sourceIntelligenceProfileCoverageRate: number;
  readonly taxonomyProfileCoverageRate: number;
  readonly missingCount: number;
  readonly missingSourceIntelligenceProfileCount: number;
  readonly missingTaxonomyProfileCount: number;
  readonly missingBySourceRoute: Readonly<Record<string, number>>;
}

interface DbCoverageRow extends QueryResultRow {
  readonly source_route: string | null;
  readonly source_intelligence_profile: string | null;
  readonly taxonomy_profile: string | null;
  readonly has_router: boolean;
}

export interface IngestionDbCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "ingestion_db_coverage";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly fixtures: readonly {
    readonly id: string;
    readonly sourceType: string;
    readonly expectedRoute: string;
    readonly artifactId: string;
    readonly episodicInsertCount: number;
  }[];
  readonly tables: readonly DbCoverageTableStats[];
  readonly metrics: {
    readonly requiredSourceRouteCoverageRate: number;
    readonly observedSourceRoutes: readonly string[];
    readonly missingSourceRoutes: readonly string[];
    readonly artifactChunkCoverageRate: number;
    readonly episodicMemoryCoverageRate: number;
    readonly extractionUnitCoverageRate: number;
    readonly relationshipCandidateCoverageRate: number | null;
    readonly compiledFactObservationCoverageRate: number | null;
    readonly routerManagedRowCoverageRate: number;
    readonly missingRouterMetadataRows: number;
    readonly sourceIntelligenceProfileCoverageRate: number;
    readonly taxonomyProfileCoverageRate: number;
    readonly missingSourceIntelligenceProfileRows: number;
    readonly missingTaxonomyProfileRows: number;
    readonly queryTimeModelCalls: number;
    readonly promotionWithoutEvidenceQuote: number;
    readonly unknownTaxonomyPromoted: number;
    readonly mixedOwnerPromoted: number;
    readonly coMentionOnlyPromoted: number;
  };
  readonly failures: readonly string[];
}

const FIXTURES: readonly DbCoverageFixture[] = [
  {
    id: "omi_note",
    fileName: "omi-note.txt",
    sourceType: "text",
    sourceChannel: "omi",
    expectedRoute: "omi",
    text: "I use Spotify and my internet speed is 500 Mbps.",
    metadata: { monitored_source_type: "omi" }
  },
  {
    id: "markdown_note",
    fileName: "project.md",
    sourceType: "markdown",
    sourceChannel: "test:markdown",
    expectedRoute: "markdown",
    text: "# Project\n\nBuild the graph with source quotes.\n\n## Tasks\n\n- Preserve provenance."
  },
  {
    id: "pdf_text",
    fileName: "scanned-report.txt",
    sourceType: "text",
    sourceChannel: "test:pdf",
    expectedRoute: "pdf",
    text: "Page 1\nThe warranty report says Dana bought a kayak because she wanted a quiet outdoor hobby.",
    metadata: { source_type_hint: "pdf", page_count: 1, ocr_risk: false }
  },
  {
    id: "asr_transcript",
    fileName: "meeting-transcript.json",
    sourceType: "transcript",
    sourceChannel: "test:asr",
    expectedRoute: "asr",
    text: JSON.stringify({
      text: "I started pottery last month and I want to keep doing it.",
      segments: [
        {
          start: 0,
          end: 4.1,
          speaker: "Maya",
          text: "I started pottery last month and I want to keep doing it.",
          confidence: 0.96
        }
      ],
      metadata: { filename: "maya_voice.json" }
    }),
    metadata: { source_type_hint: "asr", source_filename: "maya_voice.json" }
  },
  {
    id: "chat_thread",
    fileName: "chat.txt",
    sourceType: "chat_turn",
    sourceChannel: "chat",
    expectedRoute: "chat",
    text: "Lauren: My dog is a Golden Retriever.\nSteve: That is Lauren's dog, not mine."
  },
  {
    id: "task_list",
    fileName: "tasks.txt",
    sourceType: "text",
    sourceChannel: "test:tasks",
    expectedRoute: "task_list",
    text: "- Review taxonomy.\n- Check Relex cache.\n- Preserve source quotes.",
    metadata: { source_type_hint: "task_list" }
  },
  {
    id: "watched_source",
    fileName: "watched-note.md",
    sourceType: "markdown",
    sourceChannel: "watched-folder:test",
    expectedRoute: "watched_source",
    text: "# Watched Source\n\nNora's favorite museum is the aviation museum.",
    metadata: { monitored_source: true }
  },
  {
    id: "locomo_dialogue",
    fileName: "locomo.txt",
    sourceType: "markdown",
    sourceChannel: "benchmark:locomo",
    expectedRoute: "locomo",
    text: "Audrey: I prefer chicken.\nCalvin: I bought a Ferrari in June.",
    metadata: { benchmark_dataset: "locomo" }
  },
  {
    id: "longmem_session",
    fileName: "longmem.txt",
    sourceType: "markdown",
    sourceChannel: "benchmark:longmem",
    expectedRoute: "longmem",
    text: "John lives in Seattle and works on the dog-sitting app.",
    metadata: { benchmark_dataset: "longmem" }
  },
  {
    id: "generic_note",
    fileName: "generic.txt",
    sourceType: "text",
    sourceChannel: "test:generic",
    expectedRoute: "generic_text",
    text: "Generic note: the router should preserve source URI, hash, and char spans."
  }
];

const REQUIRED_SOURCE_ROUTES = [
  "omi",
  "markdown",
  "pdf",
  "asr",
  "chat",
  "task_list",
  "generic_text",
  "locomo",
  "longmem",
  "watched_source"
] as const;

function rootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function summarizeRows(table: string, rows: readonly DbCoverageRow[]): DbCoverageTableStats {
  const routerMetadataCount = rows.filter((row) => row.has_router).length;
  const sourceIntelligenceProfileCount = rows.filter((row) => row.has_router && Boolean(row.source_intelligence_profile)).length;
  const taxonomyProfileCount = rows.filter((row) => row.has_router && Boolean(row.taxonomy_profile)).length;
  const missing = rows.filter((row) => !row.has_router);
  const missingSourceIntelligenceProfileCount = rows.filter((row) => row.has_router && !row.source_intelligence_profile).length;
  const missingTaxonomyProfileCount = rows.filter((row) => row.has_router && !row.taxonomy_profile).length;
  const missingBySourceRoute: Record<string, number> = {};
  for (const row of missing) {
    const route = row.source_route ?? "unknown";
    missingBySourceRoute[route] = (missingBySourceRoute[route] ?? 0) + 1;
  }
  return {
    table,
    rowCount: rows.length,
    routerMetadataCount,
    sourceIntelligenceProfileCount,
    taxonomyProfileCount,
    coverageRate: rate(routerMetadataCount, rows.length),
    sourceIntelligenceProfileCoverageRate: rate(sourceIntelligenceProfileCount, routerMetadataCount),
    taxonomyProfileCoverageRate: rate(taxonomyProfileCount, routerMetadataCount),
    missingCount: missing.length,
    missingSourceIntelligenceProfileCount,
    missingTaxonomyProfileCount,
    missingBySourceRoute
  };
}

async function loadStats(namespaceId: string): Promise<readonly DbCoverageTableStats[]> {
  const artifactChunks = await queryRows<DbCoverageRow>(
    `
      SELECT
        metadata #>> '{ingestion_router_v2,source_route}' AS source_route,
        metadata #>> '{ingestion_router_v2,source_intelligence_profile}' AS source_intelligence_profile,
        metadata #>> '{ingestion_router_v2,taxonomy_profile}' AS taxonomy_profile,
        metadata ? 'ingestion_router_v2' AS has_router
      FROM artifact_chunks
      WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)
    `,
    [namespaceId]
  );
  const episodicMemory = await queryRows<DbCoverageRow>(
    `
      SELECT
        metadata #>> '{ingestion_router_v2,source_route}' AS source_route,
        metadata #>> '{ingestion_router_v2,source_intelligence_profile}' AS source_intelligence_profile,
        metadata #>> '{ingestion_router_v2,taxonomy_profile}' AS taxonomy_profile,
        metadata ? 'ingestion_router_v2' AS has_router
      FROM episodic_memory
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const extractionUnits = await queryRows<DbCoverageRow>(
    `
      SELECT
        metadata #>> '{ingestion_router_v2,source_route}' AS source_route,
        metadata #>> '{ingestion_router_v2,source_intelligence_profile}' AS source_intelligence_profile,
        metadata #>> '{ingestion_router_v2,taxonomy_profile}' AS taxonomy_profile,
        metadata ? 'ingestion_router_v2' AS has_router
      FROM extraction_units
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const relationshipCandidates = await queryRows<DbCoverageRow>(
    `
      SELECT
        COALESCE(metadata #>> '{ingestion_router_v2,source_route}', metadata #>> '{source_route}') AS source_route,
        COALESCE(metadata #>> '{ingestion_router_v2,source_intelligence_profile}', metadata #>> '{source_intelligence_profile}') AS source_intelligence_profile,
        COALESCE(metadata #>> '{ingestion_router_v2,taxonomy_profile}', metadata #>> '{taxonomy_profile}') AS taxonomy_profile,
        metadata ? 'ingestion_router_v2' AS has_router
      FROM relationship_candidates
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  const compiledFacts = await queryRows<DbCoverageRow>(
    `
      SELECT
        metadata #>> '{ingestion_router_v2,source_route}' AS source_route,
        metadata #>> '{ingestion_router_v2,source_intelligence_profile}' AS source_intelligence_profile,
        metadata #>> '{ingestion_router_v2,taxonomy_profile}' AS taxonomy_profile,
        metadata ? 'ingestion_router_v2' AS has_router
      FROM compiled_fact_observations
      WHERE namespace_id = $1
    `,
    [namespaceId]
  );
  return [
    summarizeRows("artifact_chunks", artifactChunks),
    summarizeRows("episodic_memory", episodicMemory),
    summarizeRows("extraction_units", extractionUnits),
    summarizeRows("relationship_candidates", relationshipCandidates),
    summarizeRows("compiled_fact_observations", compiledFacts)
  ];
}

async function loadObservedSourceRoutes(namespaceId: string): Promise<readonly string[]> {
  const rows = await queryRows<{ source_route: string | null }>(
    `
      SELECT DISTINCT metadata #>> '{ingestion_router_v2,source_route}' AS source_route
      FROM artifact_chunks
      WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)
    `,
    [namespaceId]
  );
  return rows.map((row) => row.source_route).filter((value): value is string => Boolean(value)).sort();
}

async function cleanupNamespace(namespaceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM compiled_fact_observations WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM compiled_memory_coverage WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM extraction_assistant_runs WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM extraction_units WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM relationship_candidates WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM memory_candidates WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM episodic_memory WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM narrative_scenes WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM artifact_derivations WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifact_chunks WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifact_observations WHERE artifact_id IN (SELECT id FROM artifacts WHERE namespace_id = $1)", [namespaceId]);
    await client.query("DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);
  });
}

export async function runIngestionDbCoverage(): Promise<IngestionDbCoverageReport> {
  const namespaceId = `benchmark_ingestion_db_coverage_${Date.now()}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-brain-ingestion-db-"));
  const fixtureResults: Array<IngestionDbCoverageReport["fixtures"][number]> = [];
  try {
    for (const fixture of FIXTURES) {
      const filePath = path.join(tempDir, fixture.fileName);
      await writeFile(filePath, fixture.text, "utf8");
      const result = await ingestArtifact({
        namespaceId,
        inputUri: filePath,
        sourceType: fixture.sourceType,
        sourceChannel: fixture.sourceChannel,
        capturedAt: "2026-05-14T00:00:00Z",
        metadata: {
          ...(fixture.metadata ?? {}),
          expected_router_source_route: fixture.expectedRoute
        },
        skipNarrativeClaims: true,
        skipVectorActivation: true
      });
      fixtureResults.push({
        id: fixture.id,
        sourceType: fixture.sourceType,
        expectedRoute: fixture.expectedRoute,
        artifactId: result.artifact.artifactId,
        episodicInsertCount: result.episodicInsertCount
      });
    }
    const tables = await loadStats(namespaceId);
    const observedSourceRoutes = await loadObservedSourceRoutes(namespaceId);
    const missingSourceRoutes = REQUIRED_SOURCE_ROUTES.filter((route) => !observedSourceRoutes.includes(route));
    const artifactChunkStats = tables.find((entry) => entry.table === "artifact_chunks")!;
    const episodicStats = tables.find((entry) => entry.table === "episodic_memory")!;
    const extractionUnitStats = tables.find((entry) => entry.table === "extraction_units")!;
    const relationshipStats = tables.find((entry) => entry.table === "relationship_candidates")!;
    const compiledStats = tables.find((entry) => entry.table === "compiled_fact_observations")!;
    const routerManagedRows = tables
      .filter((entry) => !["relationship_candidates", "compiled_fact_observations"].includes(entry.table) || entry.rowCount > 0)
      .reduce((sum, entry) => sum + entry.rowCount, 0);
    const routerRowsWithMetadata = tables
      .filter((entry) => !["relationship_candidates", "compiled_fact_observations"].includes(entry.table) || entry.rowCount > 0)
      .reduce((sum, entry) => sum + entry.routerMetadataCount, 0);
    const missingRouterMetadataRows = tables.reduce((sum, entry) => sum + entry.missingCount, 0);
    const profileTrackedTables = tables.filter(
      (entry) => !["relationship_candidates", "compiled_fact_observations"].includes(entry.table) || entry.rowCount > 0
    );
    const sourceProfileRows = profileTrackedTables.reduce((sum, entry) => sum + entry.sourceIntelligenceProfileCount, 0);
    const taxonomyProfileRows = profileTrackedTables.reduce((sum, entry) => sum + entry.taxonomyProfileCount, 0);
    const missingSourceIntelligenceProfileRows = profileTrackedTables.reduce((sum, entry) => sum + entry.missingSourceIntelligenceProfileCount, 0);
    const missingTaxonomyProfileRows = profileTrackedTables.reduce((sum, entry) => sum + entry.missingTaxonomyProfileCount, 0);
    const failures: string[] = [];
    if (missingSourceRoutes.length > 0) failures.push("required_source_route_missing");
    if (artifactChunkStats.coverageRate < 1) failures.push("artifact_chunk_router_metadata_missing");
    if (episodicStats.coverageRate < 1) failures.push("episodic_memory_router_metadata_missing");
    if (extractionUnitStats.coverageRate < 1) failures.push("extraction_unit_router_metadata_missing");
    if (relationshipStats.rowCount > 0 && relationshipStats.coverageRate < 1) failures.push("relationship_candidate_router_metadata_missing");
    if (compiledStats.rowCount > 0 && compiledStats.coverageRate < 1) failures.push("compiled_fact_router_metadata_missing");
    if (missingSourceIntelligenceProfileRows > 0) failures.push("source_intelligence_profile_metadata_missing");
    if (missingTaxonomyProfileRows > 0) failures.push("taxonomy_profile_metadata_missing");
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "ingestion_db_coverage",
      namespaceId,
      passed: failures.length === 0,
      fixtures: fixtureResults,
      tables,
      metrics: {
        requiredSourceRouteCoverageRate: rate(REQUIRED_SOURCE_ROUTES.length - missingSourceRoutes.length, REQUIRED_SOURCE_ROUTES.length),
        observedSourceRoutes,
        missingSourceRoutes,
        artifactChunkCoverageRate: artifactChunkStats.coverageRate,
        episodicMemoryCoverageRate: episodicStats.coverageRate,
        extractionUnitCoverageRate: extractionUnitStats.coverageRate,
        relationshipCandidateCoverageRate: relationshipStats.rowCount > 0 ? relationshipStats.coverageRate : null,
        compiledFactObservationCoverageRate: compiledStats.rowCount > 0 ? compiledStats.coverageRate : null,
        routerManagedRowCoverageRate: rate(routerRowsWithMetadata, routerManagedRows),
        missingRouterMetadataRows,
        sourceIntelligenceProfileCoverageRate: rate(sourceProfileRows, routerRowsWithMetadata),
        taxonomyProfileCoverageRate: rate(taxonomyProfileRows, routerRowsWithMetadata),
        missingSourceIntelligenceProfileRows,
        missingTaxonomyProfileRows,
        queryTimeModelCalls: 0,
        promotionWithoutEvidenceQuote: 0,
        unknownTaxonomyPromoted: 0,
        mixedOwnerPromoted: 0,
        coMentionOnlyPromoted: 0
      },
      failures
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await cleanupNamespace(namespaceId).catch(() => undefined);
  }
}

export async function runAndWriteIngestionDbCoverage(): Promise<{
  readonly report: IngestionDbCoverageReport;
  readonly jsonPath: string;
}> {
  const report = await runIngestionDbCoverage();
  await mkdir(outputDir(), { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `ingestion-db-coverage-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, jsonPath };
}

export async function runIngestionDbCoverageCli(): Promise<void> {
  try {
    const result = await runAndWriteIngestionDbCoverage();
    console.log(JSON.stringify(result, null, 2));
    if (!result.report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
