import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { closePool, queryRows, withClient } from "../db/client.js";
import { searchMemory } from "../retrieval/service.js";
import { buildBenchmarkCatalog, type BenchmarkCatalog } from "./benchmark-catalog.js";
import { benchmarkNamespaceId, withBenchmarkNamespaceLock, type BenchmarkNamespaceMutationSummary } from "./benchmark-namespace.js";

type ReviewStatus = "pass" | "warning" | "fail";

interface CoverageCase {
  readonly id: string;
  readonly query: string;
  readonly expectedClaimTerms: readonly string[];
  readonly expectedEvidenceTerms: readonly string[];
  readonly requiredFamily: string;
}

interface CoverageResult extends CoverageCase {
  readonly status: ReviewStatus;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly claimText: string | null;
  readonly evidenceCount: number;
  readonly finalClaimSource: string | null;
  readonly projectionTried: boolean;
  readonly projectionSucceeded: boolean;
  readonly projectionFamily: string | null;
  readonly projectionEvidenceCount: number;
  readonly queryTimeModelCalls: number;
}

interface ProjectionDbStats {
  readonly headCount: number;
  readonly entryCount: number;
  readonly sourceEvidenceViolationCount: number;
  readonly mixedOwnerEntryCount: number;
  readonly familyCounts: Readonly<Record<string, number>>;
}

export interface AliasCurrentStateProjectionCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "alias_current_state_projection_coverage";
  readonly artifactSchemaVersion: "alias_current_state_projection_coverage_v1";
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
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
    readonly queryTimeModelCalls: number;
    readonly unsupportedNoEvidenceSuccessCount: number;
  };
  readonly dbStats: ProjectionDbStats;
  readonly rebuildCounts: {
    readonly heads: number;
    readonly entries: number;
  };
  readonly catalog: BenchmarkCatalog;
  readonly failures: readonly string[];
  readonly cases: readonly CoverageResult[];
}

const CASES: readonly CoverageCase[] = [
  {
    id: "koh_samui_alias_exact",
    query: "What is Kozimui?",
    expectedClaimTerms: ["Koh Samui"],
    expectedEvidenceTerms: ["Koh Samui"],
    requiredFamily: "place_alias"
  },
  {
    id: "media_titles_exact",
    query: "What movies have I talked about?",
    expectedClaimTerms: ["Sinners", "Slow Horses", "Dusk Till Dawn"],
    expectedEvidenceTerms: ["Sinners", "Slow Horses", "Dusk Till Dawn"],
    requiredFamily: "media_title_list"
  },
  {
    id: "food_preference_exact",
    query: "What food did I like?",
    expectedClaimTerms: ["spicy food", "nachos"],
    expectedEvidenceTerms: ["spicy food", "nachos"],
    requiredFamily: "food_preference_list"
  },
  {
    id: "beer_preference_exact",
    query: "What are my favorite beers in Thailand?",
    expectedClaimTerms: ["Leo", "Singha", "Chang"],
    expectedEvidenceTerms: ["Leo", "Singha", "Chang"],
    requiredFamily: "beer_preference_list"
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function defaultNamespaceId(): string {
  return benchmarkNamespaceId("alias_current_state_projection_coverage");
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

function hasAllTerms(value: unknown, terms: readonly string[]): boolean {
  const text = JSON.stringify(value ?? null).toLowerCase();
  return terms.every((term) => text.includes(term.toLowerCase()));
}

function claimText(payload: Awaited<ReturnType<typeof searchMemory>>): string | null {
  return payload.duality.claim.text ?? null;
}

function shouldSeedFixture(namespaceId: string): boolean {
  return namespaceId.startsWith("benchmark_alias_current_state_projection_coverage_");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedAliasCurrentStateFixture(namespaceId: string): Promise<void> {
  if (!shouldSeedFixture(namespaceId)) {
    return;
  }
  const fixtures = [
    {
      uri: "benchmark://alias-current-state/place-alias.md",
      observedAt: "2026-03-21T10:00:00.000Z",
      text: "Steve notes that Kozimui is his shorthand nickname for Koh Samui, Thailand."
    },
    {
      uri: "benchmark://alias-current-state/media-titles.md",
      observedAt: "2026-03-21T13:08:01.000Z",
      text:
        "The speakers chat about movies and shows. They watched a vampire-themed film called Sinners, it reminded them of From Dusk Till Dawn, and Steve has been enjoying the TV series Slow Horses."
    },
    {
      uri: "benchmark://alias-current-state/food-preferences.md",
      observedAt: "2026-03-22T09:00:00.000Z",
      text: "Steve says, I like spicy food and nachos when I want comfort food."
    },
    {
      uri: "benchmark://alias-current-state/beer-preferences.md",
      observedAt: "2026-03-22T10:00:00.000Z",
      text: "Steve says his favorite beers in Thailand are Leo, Singha, and Chang, in that order."
    }
  ] as const;

  await withClient(async (client) => {
    await client.query(
      `
        INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
        VALUES ($1, 'self', 'Steve', 'steve', '{"fixture": true}'::jsonb)
        ON CONFLICT (namespace_id, entity_type, normalized_name)
        DO UPDATE SET last_seen_at = now(), metadata = entities.metadata || EXCLUDED.metadata
      `,
      [namespaceId]
    );
    for (const [index, fixture] of fixtures.entries()) {
      const artifact = await client.query<{ readonly id: string }>(
        `
          INSERT INTO artifacts (namespace_id, artifact_type, uri, latest_checksum_sha256, mime_type, source_channel, metadata)
          VALUES ($1, 'text', $2, $3, 'text/markdown', 'benchmark_fixture', '{"routerVersion":"fixture"}'::jsonb)
          ON CONFLICT (namespace_id, uri)
          DO UPDATE SET latest_checksum_sha256 = EXCLUDED.latest_checksum_sha256, last_seen_at = now()
          RETURNING id::text
        `,
        [namespaceId, fixture.uri, sha256(fixture.text)]
      );
      const artifactId = artifact.rows[0]?.id;
      if (!artifactId) {
        continue;
      }
      const observation = await client.query<{ readonly id: string }>(
        `
          INSERT INTO artifact_observations (artifact_id, version, checksum_sha256, byte_size, observed_at, metadata)
          VALUES ($1::uuid, 1, $2, $3, $4::timestamptz, '{"fixture": true}'::jsonb)
          ON CONFLICT (artifact_id, version)
          DO UPDATE SET checksum_sha256 = EXCLUDED.checksum_sha256, byte_size = EXCLUDED.byte_size, observed_at = EXCLUDED.observed_at
          RETURNING id::text
        `,
        [artifactId, sha256(fixture.text), Buffer.byteLength(fixture.text, "utf8"), fixture.observedAt]
      );
      const observationId = observation.rows[0]?.id;
      if (!observationId) {
        continue;
      }
      await client.query(
        `
          INSERT INTO artifact_chunks (artifact_id, artifact_observation_id, chunk_index, char_start, char_end, text_content, metadata)
          VALUES ($1::uuid, $2::uuid, $3, 0, length($4), $4, '{"fixture": true, "routerVersion":"fixture"}'::jsonb)
          ON CONFLICT (artifact_observation_id, chunk_index)
          DO UPDATE SET text_content = EXCLUDED.text_content, char_end = EXCLUDED.char_end, metadata = EXCLUDED.metadata
        `,
        [artifactId, observationId, index, fixture.text]
      );
    }
  });
}

async function loadDbStats(namespaceId: string): Promise<ProjectionDbStats> {
  const rows = await queryRows<{
    readonly head_count: string;
    readonly entry_count: string;
    readonly source_evidence_violation_count: string;
    readonly mixed_owner_entry_count: string;
    readonly family_counts: Record<string, number> | null;
  }>(
    `
      WITH heads AS (
        SELECT id
        FROM contract_projection_heads
        WHERE namespace_id = $1
          AND contract_name = 'alias_current_state'
          AND projection_version = 'alias_current_state_projection_v1'
          AND truth_status = 'active'
      ),
      entries AS (
        SELECT entry.*
        FROM contract_projection_entries entry
        JOIN heads ON heads.id = entry.projection_head_id
        WHERE entry.truth_status = 'active'
      )
      SELECT
        (SELECT count(*) FROM heads)::text AS head_count,
        (SELECT count(*) FROM entries)::text AS entry_count,
        (SELECT count(*) FROM entries WHERE NULLIF(metadata->>'source_quote', '') IS NULL OR source_row_id IS NULL)::text AS source_evidence_violation_count,
        (SELECT count(*) FROM entries WHERE owner_binding_status NOT IN ('self_bound', 'subject_bound', 'resolved'))::text AS mixed_owner_entry_count,
        COALESCE((SELECT jsonb_object_agg(entry_type, count) FROM (SELECT entry_type, count(*) AS count FROM entries GROUP BY entry_type) family_rows), '{}'::jsonb) AS family_counts
    `,
    [namespaceId]
  );
  const row = rows[0];
  return {
    headCount: Number(row?.head_count ?? 0),
    entryCount: Number(row?.entry_count ?? 0),
    sourceEvidenceViolationCount: Number(row?.source_evidence_violation_count ?? 0),
    mixedOwnerEntryCount: Number(row?.mixed_owner_entry_count ?? 0),
    familyCounts: row?.family_counts ?? {}
  };
}

async function runCase(namespaceId: string, testCase: CoverageCase): Promise<CoverageResult> {
  const startedAt = performance.now();
  const response = await searchMemory({ namespaceId, query: testCase.query, limit: 8 });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const failures: string[] = [];
  const text = `${claimText(response) ?? ""} ${JSON.stringify(response.evidence)}`;
  const projectionFamily = typeof response.meta.aliasCurrentStateProjectionFamily === "string" ? response.meta.aliasCurrentStateProjectionFamily : null;
  const projectionEvidenceCount =
    typeof response.meta.aliasCurrentStateProjectionEvidenceCount === "number" ? response.meta.aliasCurrentStateProjectionEvidenceCount : 0;
  if (response.meta.aliasCurrentStateProjectionTried !== true) failures.push("projection_not_tried");
  if (response.meta.aliasCurrentStateProjectionSucceeded !== true) failures.push("projection_not_succeeded");
  if (!projectionFamily?.includes(testCase.requiredFamily)) failures.push("wrong_projection_family");
  if (projectionEvidenceCount <= 0 || response.evidence.length <= 0) failures.push("projection_evidence_missing");
  if (!hasAllTerms(text, testCase.expectedClaimTerms)) failures.push("claim_terms_missing");
  if (!hasAllTerms(response.evidence, testCase.expectedEvidenceTerms)) failures.push("evidence_terms_missing");
  if (response.meta.queryTimeGLiNEROrLLMUsed === true) failures.push("query_time_model_call");
  const status: ReviewStatus = failures.length === 0 ? "pass" : hasAllTerms(text, testCase.expectedClaimTerms.slice(0, 1)) ? "warning" : "fail";
  return {
    ...testCase,
    status,
    failures,
    latencyMs,
    claimText: claimText(response),
    evidenceCount: response.evidence.length,
    finalClaimSource: typeof response.meta.finalClaimSource === "string" ? response.meta.finalClaimSource : null,
    projectionTried: response.meta.aliasCurrentStateProjectionTried === true,
    projectionSucceeded: response.meta.aliasCurrentStateProjectionSucceeded === true,
    projectionFamily,
    projectionEvidenceCount,
    queryTimeModelCalls: response.meta.queryTimeGLiNEROrLLMUsed === true ? 1 : 0
  };
}

function markdownReport(report: AliasCurrentStateProjectionCoverageReport): string {
  const caseLines = report.cases
    .map(
      (entry) => `| ${entry.status} | ${entry.id} | ${entry.latencyMs} | ${entry.finalClaimSource ?? "-"} | ${entry.projectionFamily ?? "-"} | ${entry.evidenceCount} | ${entry.failures.join("; ") || "-"} |`
    )
    .join("\n");
  return `# Alias Current-State Projection Coverage

- generatedAt: ${report.generatedAt}
- namespaceId: ${report.namespaceId}
- passed: ${report.passed}
- coverageRate: ${report.metrics.coverageRate}
- latency.p50/p95/max: ${report.metrics.p50LatencyMs}/${report.metrics.p95LatencyMs}/${report.metrics.maxLatencyMs}
- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}
- unsupportedNoEvidenceSuccessCount: ${report.metrics.unsupportedNoEvidenceSuccessCount}
- db.headCount: ${report.dbStats.headCount}
- db.entryCount: ${report.dbStats.entryCount}
- db.familyCounts: ${JSON.stringify(report.dbStats.familyCounts)}
- sourceEvidenceViolationCount: ${report.dbStats.sourceEvidenceViolationCount}
- mixedOwnerEntryCount: ${report.dbStats.mixedOwnerEntryCount}

## Failures

${report.failures.map((failure) => `- ${failure}`).join("\n") || "- none"}

## Cases

| status | id | latencyMs | final source | family | evidence | failures |
| --- | --- | ---: | --- | --- | ---: | --- |
${caseLines}
`;
}

export async function runAliasCurrentStateProjectionCoverage(
  namespaceId = defaultNamespaceId(),
  options: { readonly skipNamespaceLock?: boolean } = {}
): Promise<AliasCurrentStateProjectionCoverageReport> {
  if (!options.skipNamespaceLock) {
    const locked = await withBenchmarkNamespaceLock(namespaceId, "alias_current_state_projection_coverage", async () =>
      runAliasCurrentStateProjectionCoverage(namespaceId, { skipNamespaceLock: true })
    );
    return {
      ...locked.result,
      namespaceLockStatus: locked.lockStatus,
      mutationSummary: locked.mutationSummary
    };
  }
  const previousFlag = process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION;
  process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = "1";
  try {
    await seedAliasCurrentStateFixture(namespaceId);
    const rebuild = await rebuildContractProjectionsNamespace(namespaceId);
    const dbStats = await loadDbStats(namespaceId);
    const cases: CoverageResult[] = [];
    for (const testCase of CASES) {
      cases.push(await runCase(namespaceId, testCase));
    }
    const catalog = buildBenchmarkCatalog(
      cases.map((item) => ({
        id: item.id,
        passed: item.status === "pass",
        normalizedPassed: item.status === "pass",
        failureClass: item.failures[0] ?? null,
        queryBehavior: item.requiredFamily,
        finalClaimSource: item.finalClaimSource,
        latencyMs: item.latencyMs
      }))
    );
    const latencies = cases.map((item) => item.latencyMs);
    const passCount = cases.filter((item) => item.status === "pass").length;
    const unsupportedNoEvidenceSuccessCount = cases.filter((item) => item.status === "pass" && item.evidenceCount === 0).length;
    const metrics = {
      coverageRate: rate(passCount, cases.length),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      maxLatencyMs: latencies.length > 0 ? Number(Math.max(...latencies).toFixed(2)) : 0,
      queryTimeModelCalls: cases.reduce((sum, item) => sum + item.queryTimeModelCalls, 0),
      unsupportedNoEvidenceSuccessCount
    };
    const failures: string[] = [];
    if (metrics.coverageRate < 0.95) failures.push("coverage_below_threshold");
    if (metrics.p95LatencyMs > 500) failures.push("p95_latency_above_threshold");
    if (metrics.maxLatencyMs > 1500) failures.push("max_latency_above_threshold");
    if (metrics.queryTimeModelCalls > 0) failures.push("query_time_model_calls");
    if (unsupportedNoEvidenceSuccessCount > 0) failures.push("unsupported_no_evidence_success");
    if (dbStats.sourceEvidenceViolationCount > 0) failures.push("projection_source_evidence_violation");
    if (dbStats.mixedOwnerEntryCount > 0) failures.push("mixed_owner_projection_entry");
    return {
      generatedAt: new Date().toISOString(),
      benchmark: "alias_current_state_projection_coverage",
      artifactSchemaVersion: "alias_current_state_projection_coverage_v1",
      namespaceId,
      namespaceLockStatus: "not_applicable",
      mutationSummary: null,
      passed: failures.length === 0,
      thresholds: {
        coverageRate: 0.95,
        p95LatencyMs: 500,
        maxLatencyMs: 1500
      },
      metrics,
      dbStats,
      rebuildCounts: rebuild.counts,
      catalog,
      failures,
      cases
    };
  } finally {
    if (previousFlag === undefined) {
      delete process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION;
    } else {
      process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION = previousFlag;
    }
  }
}

export async function runAliasCurrentStateProjectionCoverageCli(): Promise<void> {
  try {
    const namespaceId = process.argv[2] || defaultNamespaceId();
    const report = await runAliasCurrentStateProjectionCoverage(namespaceId);
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/gu, "-");
    const jsonPath = path.join(dir, `alias-current-state-projection-coverage-${stamp}.json`);
    const markdownPath = path.join(dir, `alias-current-state-projection-coverage-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, markdownReport(report), "utf8");
    process.stdout.write(`${JSON.stringify({ passed: report.passed, jsonPath, markdownPath, metrics: report.metrics, failures: report.failures }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
