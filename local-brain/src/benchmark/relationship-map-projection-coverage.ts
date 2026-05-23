import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool, queryRows, withClient } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";
import { withBenchmarkNamespaceLock, type BenchmarkNamespaceMutationSummary } from "./benchmark-namespace.js";

type RelationshipProjectionFamily = "relationship_map" | "relationship_chronology";

interface RelationshipMapProjectionCase {
  readonly id: string;
  readonly family: RelationshipProjectionFamily;
  readonly query: string;
  readonly expectedClaimTerms: readonly string[];
}

interface RelationshipMapProjectionCaseResult extends RelationshipMapProjectionCase {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly projectionTried: boolean;
  readonly projectionSucceeded: boolean;
  readonly projectionVersion: string | null;
  readonly projectionEntryCount: number;
  readonly projectionEvidenceCount: number;
  readonly evidenceCount: number;
  readonly finalClaimSource: string | null;
  readonly dominantStage: string | null;
  readonly queryTimeModelCalls: number;
  readonly claim: string;
}

interface RelationshipMapProjectionDbStats {
  readonly mapHeadCount: number;
  readonly mapEntryCount: number;
  readonly chronologyHeadCount: number;
  readonly chronologyEntryCount: number;
  readonly sourceEvidenceViolationCount: number;
  readonly mixedOwnerEntryCount: number;
}

interface RelationshipMapProjectionCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "relationship_map_projection_coverage";
  readonly artifactSchemaVersion: "relationship_map_projection_coverage_v2";
  readonly namespaceId: string;
  readonly namespaceLockStatus: "acquired" | "not_applicable";
  readonly mutationSummary: BenchmarkNamespaceMutationSummary | null;
  readonly passed: boolean;
  readonly thresholds: {
    readonly coverageRate: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly metrics: {
    readonly coverageRate: number;
    readonly mapCoverageRate: number;
    readonly chronologyCoverageRate: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
    readonly queryTimeModelCalls: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
    readonly sourceEvidenceViolationCount: number;
    readonly mixedOwnerEntryCount: number;
  };
  readonly dbStats: RelationshipMapProjectionDbStats;
  readonly rebuildCounts: {
    readonly heads: number;
    readonly entries: number;
  };
  readonly failures: readonly string[];
  readonly cases: readonly RelationshipMapProjectionCaseResult[];
}

const CASES: readonly RelationshipMapProjectionCase[] = [
  {
    id: "dan_exact_relationship",
    family: "relationship_map",
    query: "Who is Dan in my life right now, exactly?",
    expectedClaimTerms: ["Dan", "friend"]
  },
  {
    id: "john_exact_relationship",
    family: "relationship_map",
    query: "Who is John in my life, and what is he associated with?",
    expectedClaimTerms: ["John", "associated"]
  },
  {
    id: "lauren_exact_relationship",
    family: "relationship_map",
    query: "Who is Lauren in my life right now, exactly?",
    expectedClaimTerms: ["Lauren", "former"]
  },
  {
    id: "james_exact_relationship",
    family: "relationship_map",
    query: "Who is James in my life right now, exactly?",
    expectedClaimTerms: ["James", "friend"]
  },
  {
    id: "ben_exact_relationship",
    family: "relationship_map",
    query: "Who is Ben in my life right now, exactly?",
    expectedClaimTerms: ["Ben"]
  },
  {
    id: "multi_person_relationship_map",
    family: "relationship_map",
    query: "Who are Dan, John, Lauren, and James in my life right now?",
    expectedClaimTerms: ["Dan", "John", "Lauren", "James"]
  },
  {
    id: "lauren_relationship_history",
    family: "relationship_chronology",
    query: "What is Steve's history with Lauren?",
    expectedClaimTerms: ["Lauren"]
  },
  {
    id: "lauren_relationship_transition",
    family: "relationship_chronology",
    query: "How has my relationship with Lauren changed recently?",
    expectedClaimTerms: ["Lauren"]
  }
];

const DEFAULT_FIXTURE_NAMESPACE = "benchmark_relationship_map_projection_fixture";

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[index] ?? 0).toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function hasAllTerms(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every((term) => normalized.includes(term.toLowerCase()));
}

async function loadDbStats(namespaceId: string): Promise<RelationshipMapProjectionDbStats> {
  const rows = await queryRows<{
    readonly map_head_count: string;
    readonly map_entry_count: string;
    readonly chronology_head_count: string;
    readonly chronology_entry_count: string;
    readonly source_evidence_violation_count: string;
    readonly mixed_owner_entry_count: string;
  }>(
    `
      WITH heads AS (
        SELECT id, contract_name
        FROM contract_projection_heads
        WHERE namespace_id = $1
          AND contract_name IN ('relationship_map', 'relationship_chronology')
          AND projection_kind = 'report'
          AND projection_version IN ('relationship_map_projection_v1', 'relationship_chronology_projection_v1')
          AND truth_status = 'active'
      ),
      entries AS (
        SELECT entry.*, heads.contract_name
        FROM contract_projection_entries entry
        JOIN heads ON heads.id = entry.projection_head_id
        WHERE entry.truth_status = 'active'
          AND entry.active_truth = true
      )
      SELECT
        (SELECT count(*) FROM heads WHERE contract_name = 'relationship_map')::text AS map_head_count,
        (SELECT count(*) FROM entries WHERE contract_name = 'relationship_map')::text AS map_entry_count,
        (SELECT count(*) FROM heads WHERE contract_name = 'relationship_chronology')::text AS chronology_head_count,
        (SELECT count(*) FROM entries WHERE contract_name = 'relationship_chronology')::text AS chronology_entry_count,
        (SELECT count(*) FROM entries WHERE NULLIF(metadata->>'source_quote', '') IS NULL OR source_row_id IS NULL)::text AS source_evidence_violation_count,
        (SELECT count(*) FROM entries WHERE owner_binding_status IS DISTINCT FROM 'subject_pair_bound')::text AS mixed_owner_entry_count
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    mapHeadCount: Number(row?.map_head_count ?? 0),
    mapEntryCount: Number(row?.map_entry_count ?? 0),
    chronologyHeadCount: Number(row?.chronology_head_count ?? 0),
    chronologyEntryCount: Number(row?.chronology_entry_count ?? 0),
    sourceEvidenceViolationCount: Number(row?.source_evidence_violation_count ?? 0),
    mixedOwnerEntryCount: Number(row?.mixed_owner_entry_count ?? 0)
  };
}

async function seedRelationshipProjectionFixture(namespaceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM contract_projection_entries WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM contract_projection_heads WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM relationship_candidates WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM namespace_self_bindings WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM episodic_memory WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM entities WHERE namespace_id = $1", [namespaceId]);
    await client.query("DELETE FROM artifacts WHERE namespace_id = $1", [namespaceId]);

    const identity = await client.query<{ readonly id: string }>(
      `
        INSERT INTO identity_profiles (profile_type, canonical_name, normalized_name, metadata)
        VALUES ('self', $1::text, lower($1::text), jsonb_build_object('benchmark_fixture', $2::text))
        ON CONFLICT (profile_type, normalized_name)
        DO UPDATE SET updated_at = now(), metadata = identity_profiles.metadata || excluded.metadata
        RETURNING id::text
      `,
      [`Steve Tietze ${namespaceId}`, namespaceId]
    );
    const identityId = identity.rows[0]!.id;
    const entityIds = new Map<string, string>();
    for (const name of ["Steve Tietze", "Dan", "John", "Lauren", "James", "Ben"]) {
      const entity = await client.query<{ readonly id: string }>(
        `
          INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
          VALUES ($1, 'person', $2, lower($2), jsonb_build_object('benchmark_fixture', true))
          RETURNING id::text
        `,
        [namespaceId, name]
      );
      entityIds.set(name, entity.rows[0]!.id);
    }
    const samuiExperience = await client.query<{ readonly id: string }>(
      `
        INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
        VALUES ($1, 'org', 'Samui Experience', 'samui experience', jsonb_build_object('benchmark_fixture', true))
        RETURNING id::text
      `,
      [namespaceId]
    );
    entityIds.set("Samui Experience", samuiExperience.rows[0]!.id);
    await client.query(
      `
        INSERT INTO namespace_self_bindings (namespace_id, identity_profile_id, entity_id, display_name, metadata)
        VALUES ($1, $2::uuid, $3::uuid, 'Steve Tietze', jsonb_build_object('benchmark_fixture', true))
      `,
      [namespaceId, identityId, entityIds.get("Steve Tietze")]
    );

    const artifact = await client.query<{ readonly id: string }>(
      `
        INSERT INTO artifacts (namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata)
        VALUES ($1, 'benchmark_fixture', 'benchmark://relationship-map-projection-fixture', repeat('0', 64), 'text/markdown', 'benchmark', jsonb_build_object('benchmark_fixture', true))
        RETURNING id::text
      `,
      [namespaceId]
    );
    const artifactId = artifact.rows[0]!.id;

    async function insertMemory(content: string, occurredAt: string): Promise<string> {
      const memory = await client.query<{ readonly id: string }>(
        `
          INSERT INTO episodic_memory (namespace_id, session_id, role, content, occurred_at, captured_at, artifact_id, metadata)
          VALUES ($1, 'relationship-map-projection-fixture', 'import', $2, $3::timestamptz, $3::timestamptz, $4::uuid, jsonb_build_object('benchmark_fixture', true))
          RETURNING id::text
        `,
        [namespaceId, content, occurredAt, artifactId]
      );
      return memory.rows[0]!.id;
    }

    async function insertCandidate(subject: string, predicate: string, object: string, snippet: string, occurredAt: string): Promise<void> {
      const memoryId = await insertMemory(snippet, occurredAt);
      await client.query(
        `
          INSERT INTO relationship_candidates (
            namespace_id, subject_entity_id, predicate, object_entity_id, source_memory_id,
            confidence, status, valid_from, metadata
          )
          VALUES (
            $1, $2::uuid, $3, $4::uuid, $5::uuid,
            0.94, 'accepted', $6::timestamptz,
            jsonb_build_object('snippet', $7::text, 'benchmark_fixture', true)
          )
        `,
        [namespaceId, entityIds.get(subject), predicate, entityIds.get(object), memoryId, occurredAt, snippet]
      );
    }

    await insertCandidate("Steve Tietze", "friend_of", "Dan", "Dan is your friend from Chiang Mai and Mexico City.", "2026-03-01T10:00:00Z");
    await insertCandidate("Steve Tietze", "friend_of", "John", "John is your friend from Chiang Mai and owner of Samui Experience on Koh Samui.", "2026-03-02T10:00:00Z");
    await insertCandidate("John", "associated_with", "Samui Experience", "John is associated with Samui Experience on Koh Samui.", "2026-03-02T11:00:00Z");
    await insertCandidate("Steve Tietze", "friend_of", "James", "James is your friend from Burning Man and is associated with Lake Tahoe.", "2026-03-03T10:00:00Z");
    await insertCandidate("Steve Tietze", "friend_of", "Ben", "Ben is your friend from Mexico City and is connected to Well Inked.", "2026-03-04T10:00:00Z");
    await insertCandidate("Steve Tietze", "former_partner_of", "Lauren", "Lauren is your former romantic partner and former partner from Lake Tahoe, Bend, and Thailand.", "2025-10-18T10:00:00Z");
    await insertCandidate("Steve Tietze", "relationship_contact_paused", "Lauren", "Steve and Lauren stopped talking around October 18, 2025 after a long relationship history.", "2025-10-18T12:00:00Z");
    await insertCandidate("Steve Tietze", "friend_of", "Lauren", "Lauren is also one of your best friends from Thailand and Chiang Mai.", "2026-03-05T10:00:00Z");
  });
}

async function runCase(namespaceId: string, testCase: RelationshipMapProjectionCase): Promise<RelationshipMapProjectionCaseResult> {
  const startedAt = performance.now();
  const response = await searchMemory({ namespaceId, query: testCase.query, limit: 6 });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const claim = response.duality.claim.text ?? "";
  const evidenceText = response.evidence.map((entry) => entry.snippet).join(" ");
  const projectionTried = response.meta.relationshipMapProjectionTried === true;
  const projectionSucceeded = response.meta.relationshipMapProjectionSucceeded === true;
  const projectionEntryCount = response.meta.relationshipMapProjectionEntryCount ?? 0;
  const projectionEvidenceCount = response.meta.relationshipMapProjectionEvidenceCount ?? 0;
  const queryTimeModelCalls = response.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0;
  const finalClaimSource = response.meta.finalClaimSource ?? null;
  const failures: string[] = [];

  if (!projectionTried) failures.push("relationship_projection_not_tried");
  if (!projectionSucceeded) failures.push(response.meta.relationshipMapProjectionBlockedReason ?? "relationship_projection_not_succeeded");
  if (projectionEntryCount <= 0 || projectionEvidenceCount <= 0 || response.evidence.length <= 0) {
    failures.push("relationship_projection_evidence_missing");
  }
  if (queryTimeModelCalls > 0) failures.push("query_time_model_calls");
  if (!hasAllTerms(`${claim} ${evidenceText}`, testCase.expectedClaimTerms)) failures.push("expected_terms_missing");
  if (testCase.family === "relationship_map" && finalClaimSource !== "relationship_map_projection") {
    failures.push("relationship_map_not_final_source");
  }
  if (testCase.family === "relationship_chronology" && finalClaimSource !== "relationship_chronology_projection") {
    failures.push("relationship_chronology_not_final_source");
  }

  return {
    ...testCase,
    passed: failures.length === 0,
    failures,
    latencyMs,
    projectionTried,
    projectionSucceeded,
    projectionVersion: response.meta.relationshipMapProjectionVersion ?? null,
    projectionEntryCount,
    projectionEvidenceCount,
    evidenceCount: response.evidence.length,
    finalClaimSource,
    dominantStage: response.meta.dominantStage ?? null,
    queryTimeModelCalls,
    claim
  };
}

export async function runRelationshipMapProjectionCoverageBenchmark(
  namespaceId = process.env.BRAIN_RELATIONSHIP_MAP_PROJECTION_NAMESPACE ?? DEFAULT_FIXTURE_NAMESPACE,
  options: { readonly skipNamespaceLock?: boolean } = {}
): Promise<RelationshipMapProjectionCoverageReport> {
  if (!options.skipNamespaceLock) {
    const locked = await withBenchmarkNamespaceLock(namespaceId, "relationship_map_projection_coverage", async () =>
      runRelationshipMapProjectionCoverageBenchmark(namespaceId, { skipNamespaceLock: true })
    );
    return {
      ...locked.result,
      namespaceLockStatus: locked.lockStatus,
      mutationSummary: locked.mutationSummary
    };
  }
  const previousFlag = process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
  process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = "1";
  try {
    if (namespaceId === DEFAULT_FIXTURE_NAMESPACE || process.env.BRAIN_RELATIONSHIP_MAP_PROJECTION_SEED_FIXTURE === "1") {
      await seedRelationshipProjectionFixture(namespaceId);
    }
    const rebuild = await rebuildContractProjectionsNamespace(namespaceId);
    const dbStats = await loadDbStats(namespaceId);
    const cases: RelationshipMapProjectionCaseResult[] = [];
    for (const testCase of CASES) {
      cases.push(await runCase(namespaceId, testCase));
    }
    const latencies = cases.map((entry) => entry.latencyMs);
    const mapCases = cases.filter((entry) => entry.family === "relationship_map");
    const chronologyCases = cases.filter((entry) => entry.family === "relationship_chronology");
    const thresholds = {
      coverageRate: 0.9,
      p95LatencyMs: 500,
      maxLatencyMs: 1500
    };
    const metrics = {
      coverageRate: rate(cases.filter((entry) => entry.passed).length, cases.length),
      mapCoverageRate: rate(mapCases.filter((entry) => entry.passed).length, mapCases.length),
      chronologyCoverageRate: rate(chronologyCases.filter((entry) => entry.passed).length, chronologyCases.length),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      maxLatencyMs: Number(Math.max(0, ...latencies).toFixed(2)),
      queryTimeModelCalls: cases.reduce((sum, entry) => sum + entry.queryTimeModelCalls, 0),
      unsupportedNoEvidenceSuccessCount: cases.filter((entry) => entry.projectionSucceeded && entry.evidenceCount === 0).length,
      sourceEvidenceViolationCount: dbStats.sourceEvidenceViolationCount,
      mixedOwnerEntryCount: dbStats.mixedOwnerEntryCount
    };
    const failures: string[] = [];
    if (dbStats.mapHeadCount === 0 || dbStats.mapEntryCount === 0) failures.push("relationship_map_projection_missing");
    if (dbStats.chronologyHeadCount === 0 || dbStats.chronologyEntryCount === 0) failures.push("relationship_chronology_projection_missing");
    if (metrics.coverageRate < thresholds.coverageRate) failures.push("coverage_below_threshold");
    if (metrics.p95LatencyMs > thresholds.p95LatencyMs) failures.push("p95_latency_exceeded");
    if (metrics.maxLatencyMs > thresholds.maxLatencyMs) failures.push("max_latency_exceeded");
    if (metrics.sourceEvidenceViolationCount > 0) failures.push("projection_source_evidence_violation");
    if (metrics.mixedOwnerEntryCount > 0) failures.push("mixed_owner_projection_entry");
    if (metrics.unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
    if (metrics.queryTimeModelCalls > 0) failures.push("query_time_model_calls");
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "relationship_map_projection_coverage",
      artifactSchemaVersion: "relationship_map_projection_coverage_v2",
      namespaceId,
      namespaceLockStatus: "not_applicable",
      mutationSummary: null,
      passed: failures.length === 0,
      thresholds,
      metrics,
      dbStats,
      rebuildCounts: rebuild.counts,
      failures,
      cases
    };
  } finally {
    if (previousFlag === undefined) delete process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION;
    else process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION = previousFlag;
  }
}

function markdownReport(report: RelationshipMapProjectionCoverageReport): string {
  const rows = report.cases
    .map(
      (entry) =>
        `| ${entry.passed ? "PASS" : "FAIL"} | ${entry.family} | ${entry.latencyMs} | ${entry.projectionSucceeded ? "yes" : "no"} | ${entry.evidenceCount} | ${entry.finalClaimSource ?? "-"} | ${entry.failures.join(", ") || "-"} | ${entry.id} |`
    )
    .join("\n");
  return `# Relationship Map Projection Coverage

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- passed: ${report.passed}
- coverageRate: ${report.metrics.coverageRate}
- mapCoverageRate: ${report.metrics.mapCoverageRate}
- chronologyCoverageRate: ${report.metrics.chronologyCoverageRate}
- p95LatencyMs: ${report.metrics.p95LatencyMs}
- maxLatencyMs: ${report.metrics.maxLatencyMs}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- sourceEvidenceViolationCount: ${report.metrics.sourceEvidenceViolationCount}
- mixedOwnerEntryCount: ${report.metrics.mixedOwnerEntryCount}
- mapHeads/entries: ${report.dbStats.mapHeadCount}/${report.dbStats.mapEntryCount}
- chronologyHeads/entries: ${report.dbStats.chronologyHeadCount}/${report.dbStats.chronologyEntryCount}

| status | family | latencyMs | projection | evidence | final source | failures | case |
| --- | --- | ---: | --- | ---: | --- | --- | --- |
${rows}
`;
}

export async function runRelationshipMapProjectionCoverageCli(): Promise<void> {
  try {
    const namespaceArgIndex = process.argv.indexOf("--namespace");
    const namespaceId = namespaceArgIndex >= 0 ? process.argv[namespaceArgIndex + 1] : undefined;
    const report = await runRelationshipMapProjectionCoverageBenchmark(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `relationship-map-projection-coverage-${stamp}.json`);
    const markdownPath = path.join(dir, `relationship-map-projection-coverage-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, markdownReport(report));
    console.log(JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures }, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
