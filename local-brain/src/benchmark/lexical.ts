import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows, closePool } from "../db/client.js";
import { runLocalEvaluation } from "../eval/runner.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { searchMemory } from "../retrieval/service.js";

interface BenchmarkCase {
  readonly name: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly expectTopIncludes?: readonly string[];
  readonly rejectTopIncludes?: readonly string[];
  readonly expectTopMemoryType?: string;
  readonly expectTopMemoryTypes?: readonly string[];
  readonly expectZeroResults?: boolean;
  readonly maxResultCount?: number;
  readonly expectTopOverlapMin?: number;
  readonly maxApproxTokens?: number;
}

interface BenchmarkCaseResult {
  readonly name: string;
  readonly provider: "fts" | "bm25";
  readonly passed: boolean;
  readonly resultCount: number;
  readonly effectiveLexicalProvider: "fts" | "bm25";
  readonly lexicalFallbackUsed: boolean;
  readonly lexicalFallbackReason?: string;
  readonly topMemoryType?: string;
  readonly topContent?: string;
  readonly topOverlap?: number;
  readonly approxTokens: number;
  readonly failureReasons: readonly string[];
}

export interface LexicalBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly baselineEvalPassed: boolean;
  readonly baselineEvalFailures: readonly string[];
  readonly cases: readonly BenchmarkCaseResult[];
  readonly summary: {
    readonly ftsPassed: number;
    readonly bm25Passed: number;
    readonly totalCases: number;
    readonly bm25TokenDelta: number;
    readonly bm25FallbackCases: number;
    readonly recommendation: "keep_feature_gated" | "candidate_for_default";
    readonly reason: string;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultOutputDir(): string {
  return path.resolve(thisDir(), "../../benchmark-results");
}

function approxTokenCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeTopWindowOverlap(
  top: Awaited<ReturnType<typeof searchMemory>>["results"][number] | undefined,
  timeStart: string | undefined,
  timeEnd: string | undefined
): number | undefined {
  if (!top || !timeStart || !timeEnd) {
    return undefined;
  }

  const queryStart = parseIsoTimestamp(timeStart);
  const queryEnd = parseIsoTimestamp(timeEnd);
  if (queryStart === null || queryEnd === null || queryEnd <= queryStart) {
    return undefined;
  }

  if (top.memoryType === "temporal_nodes") {
    const periodStart = parseIsoTimestamp(typeof top.provenance.period_start === "string" ? top.provenance.period_start : undefined);
    const periodEnd = parseIsoTimestamp(typeof top.provenance.period_end === "string" ? top.provenance.period_end : undefined);
    if (periodStart === null || periodEnd === null || periodEnd <= periodStart) {
      return undefined;
    }

    const overlapStart = Math.max(queryStart, periodStart);
    const overlapEnd = Math.min(queryEnd, periodEnd);
    if (overlapEnd <= overlapStart) {
      return 0;
    }

    return (overlapEnd - overlapStart) / (periodEnd - periodStart);
  }

  const occurredAt = parseIsoTimestamp(top.occurredAt ?? undefined);
  if (occurredAt === null) {
    return undefined;
  }

  return occurredAt >= queryStart && occurredAt <= queryEnd ? 1 : 0;
}

function makeBenchmarkEmbedding(seed = 0): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[seed % vector.length] = 1;
  vector[(seed + 19) % vector.length] = 0.55;
  vector[(seed + 71) % vector.length] = 0.2;
  return vector;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  {
    name: "chiang_mai_exact_temporal",
    query: "Chiang Mai Gumi CTO 2026",
    timeStart: "2026-01-01T00:00:00Z",
    timeEnd: "2026-12-31T23:59:59Z",
    expectTopIncludes: ["Chiang Mai", "Gumi", "2026"],
    expectTopMemoryTypes: ["episodic_memory", "temporal_nodes"],
    expectTopOverlapMin: 0.5,
    maxApproxTokens: 140
  },
  {
    name: "chiang_mai_temporal_natural_language",
    query: "What was I doing in Chiang Mai in 2026?",
    expectTopIncludes: ["Chiang Mai"],
    expectTopMemoryTypes: ["episodic_memory", "temporal_nodes"],
    expectTopOverlapMin: 0.5,
    maxApproxTokens: 160
  },
  {
    name: "current_relationship_live_query",
    query: "where does Steve live?",
    expectTopIncludes: ["Steve", "Chiang Mai"],
    expectTopMemoryType: "relationship_memory",
    maxApproxTokens: 40
  },
  {
    name: "alias_collision_stephen",
    query: "Stephen summer home Tahoe",
    expectTopIncludes: ["Stephen", "summer home", "Tahoe"],
    rejectTopIncludes: ["Steven Park", "Project Atlas"],
    expectTopMemoryType: "episodic_memory",
    maxResultCount: 1,
    maxApproxTokens: 140
  },
  {
    name: "march_redesign_date",
    query: "March 12 2025 redesign notes",
    expectTopIncludes: ["March", "2025", "redesign"],
    expectTopMemoryType: "episodic_memory",
    maxApproxTokens: 140
  },
  {
    name: "coffee_active_truth",
    query: "current coffee brew method",
    expectTopIncludes: ["pour over"],
    rejectTopIncludes: ["French press"],
    expectTopMemoryType: "procedural_memory",
    maxApproxTokens: 140
  },
  {
    name: "spicy_active_truth",
    query: "spicy food",
    expectTopIncludes: ["spicy", "dislike"],
    expectTopMemoryType: "procedural_memory",
    maxApproxTokens: 120
  },
  {
    name: "sweet_active_truth",
    query: "sweet food",
    expectTopIncludes: ["sweet", "like"],
    expectTopMemoryType: "procedural_memory",
    maxApproxTokens: 120
  },
  {
    name: "rare_entity_cve",
    query: "CVE-2026-3172 buffer overflow",
    expectTopIncludes: ["CVE-2026-3172", "buffer overflow"],
    expectTopMemoryType: "semantic_memory",
    maxResultCount: 1,
    maxApproxTokens: 120
  },
  {
    name: "version_precision_pgvector",
    query: "pgvector 0.8.2 sparsevec release",
    expectTopIncludes: ["pgvector 0.8.2", "sparsevec"],
    expectTopMemoryType: "semantic_memory",
    maxApproxTokens: 120
  },
  {
    name: "acronym_precision_sqs_dlq",
    query: "SQS DLQ setup",
    expectTopIncludes: ["SQS", "DLQ"],
    expectTopMemoryType: "semantic_memory",
    maxApproxTokens: 120
  },
  {
    name: "provenance_hash_lookup",
    query: "artifact hash c6b7e8",
    expectTopIncludes: ["c6b7e8"],
    expectTopMemoryType: "artifact_derivation",
    maxApproxTokens: 120
  },
  {
    name: "artifact_ocr_port",
    query: "port 3000 screenshot",
    expectTopIncludes: ["port 3000", "screenshot"],
    expectTopMemoryType: "artifact_derivation",
    maxApproxTokens: 120
  },
  {
    name: "entity_collision_sara",
    query: "Sara Kyoto dinner",
    expectTopIncludes: ["Sara Alvarez", "Kyoto dinner"],
    rejectTopIncludes: ["Sarah and Ken"],
    expectTopMemoryType: "episodic_memory",
    maxResultCount: 1,
    maxApproxTokens: 120
  },
  {
    name: "abstention_unknown",
    query: "quantum pineapple architecture decision that was never mentioned",
    expectZeroResults: true,
    maxApproxTokens: 0
  }
];

async function insertEpisodic(
  namespaceId: string,
  content: string,
  occurredAt: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const checksum = `benchmark-${Buffer.from(`${occurredAt}:${content}`).toString("hex").slice(0, 24)}`;
  const uri = `benchmark://episodic/${checksum}.md`;
  const [artifact] = await queryRows<{ artifact_id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1, 'markdown_session', $2, $3, 'text/markdown', 'benchmark', $4::jsonb)
      RETURNING id AS artifact_id
    `,
    [namespaceId, uri, checksum, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [observation] = await queryRows<{ observation_id: string }>(
    `
      INSERT INTO artifact_observations (
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      )
      VALUES ($1, 1, $2, $3, $4::timestamptz, $5::jsonb)
      RETURNING id AS observation_id
    `,
    [artifact.artifact_id, checksum, content.length, occurredAt, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [chunk] = await queryRows<{ chunk_id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id,
        artifact_observation_id,
        chunk_index,
        char_start,
        char_end,
        text_content,
        metadata
      )
      VALUES ($1, $2, 0, 0, $3, $4, $5::jsonb)
      RETURNING id AS chunk_id
    `,
    [artifact.artifact_id, observation.observation_id, content.length, content, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [inserted] = await queryRows<{ memory_id: string }>(
    `
      INSERT INTO episodic_memory (
        namespace_id,
        session_id,
        role,
        content,
        occurred_at,
        captured_at,
        artifact_id,
        artifact_observation_id,
        source_chunk_id,
        source_offset,
        token_count,
        metadata
      )
      VALUES ($1, $2, 'import', $3, $4::timestamptz, $4::timestamptz, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
      RETURNING id AS memory_id
    `,
    [
      namespaceId,
      "benchmark_corpus",
      content,
      occurredAt,
      artifact.artifact_id,
      observation.observation_id,
      chunk.chunk_id,
      JSON.stringify({ char_start: 0, char_end: content.length }),
      approxTokenCount(content),
      JSON.stringify(metadata)
    ]
  );

  await queryRows(
    `
      INSERT INTO episodic_timeline (
        occurred_at,
        memory_id,
        namespace_id,
        session_id,
        role,
        content,
        captured_at,
        token_count,
        metadata
      )
      SELECT
        occurred_at,
        id,
        namespace_id,
        session_id,
        role,
        content,
        captured_at,
        token_count,
        metadata
      FROM episodic_memory
      WHERE id = $1
      ON CONFLICT (occurred_at, memory_id) DO NOTHING
    `,
    [inserted.memory_id]
  );
}

async function insertSemantic(
  namespaceId: string,
  content: string,
  seed: number,
  validFrom: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await queryRows(
    `
      INSERT INTO semantic_memory (
        namespace_id,
        content_abstract,
        embedding,
        embedding_model,
        importance_score,
        valid_from,
        metadata
      )
      VALUES ($1, $2, $3::vector, 'benchmark.synthetic', 0.9, $4::timestamptz, $5::jsonb)
    `,
    [namespaceId, content, toVectorLiteral(makeBenchmarkEmbedding(seed)), validFrom, JSON.stringify(metadata)]
  );
}

async function insertProcedural(
  namespaceId: string,
  stateType: string,
  stateKey: string,
  stateValue: Record<string, unknown>,
  validFrom: string,
  validUntil: string | null,
  version: number,
  supersedesId: string | null = null
): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9::jsonb)
      RETURNING id
    `,
    [
      namespaceId,
      stateType,
      stateKey,
      JSON.stringify(stateValue),
      version,
      validFrom,
      validUntil,
      supersedesId,
      JSON.stringify({ benchmark_seed: true })
    ]
  );
  return row.id;
}

async function upsertEntity(
  namespaceId: string,
  entityType: string,
  canonicalName: string
): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        last_seen_at,
        metadata
      )
      VALUES ($1, $2, $3, lower($3), now(), $4::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id
    `,
    [namespaceId, entityType, canonicalName, JSON.stringify({ benchmark_seed: true })]
  );

  return row.id;
}

async function insertRelationshipMemory(
  namespaceId: string,
  subjectName: string,
  predicate: string,
  objectName: string,
  objectType: string,
  validFrom: string,
  confidence = 0.95
): Promise<void> {
  const subjectId = await upsertEntity(namespaceId, "person", subjectName);
  const objectId = await upsertEntity(namespaceId, objectType, objectName);

  await queryRows(
    `
      INSERT INTO relationship_memory (
        namespace_id,
        subject_entity_id,
        predicate,
        object_entity_id,
        confidence,
        status,
        valid_from,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz, $7::jsonb)
      ON CONFLICT (namespace_id, subject_entity_id, predicate, object_entity_id, valid_from)
      DO NOTHING
    `,
    [namespaceId, subjectId, predicate, objectId, confidence, validFrom, JSON.stringify({ benchmark_seed: true })]
  );
}

async function insertArtifactDerivation(
  namespaceId: string,
  uri: string,
  checksum: string,
  observedAt: string,
  derivationType: string,
  contentText: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const [artifact] = await queryRows<{ artifact_id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1, 'image', $2, $3, 'image/png', 'benchmark', $4::jsonb)
      RETURNING id AS artifact_id
    `,
    [namespaceId, uri, checksum, JSON.stringify({ benchmark_seed: true })]
  );
  const [observation] = await queryRows<{ observation_id: string }>(
    `
      INSERT INTO artifact_observations (
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      )
      VALUES ($1, 1, $2, 0, $3::timestamptz, $4::jsonb)
      RETURNING id AS observation_id
    `,
    [artifact.artifact_id, checksum, observedAt, JSON.stringify({ benchmark_seed: true })]
  );
  await queryRows(
    `
      INSERT INTO artifact_derivations (
        artifact_observation_id,
        derivation_type,
        provider,
        model,
        content_text,
        embedding,
        output_dimensionality,
        metadata
      )
      VALUES ($1, $2, 'benchmark', 'synthetic', $3, $4::vector, 1536, $5::jsonb)
    `,
    [
      observation.observation_id,
      derivationType,
      contentText,
      toVectorLiteral(makeBenchmarkEmbedding(contentText.length % 97)),
      JSON.stringify(metadata)
    ]
  );
}

async function seedBenchmarkCorpus(namespaceId: string): Promise<void> {
  await insertEpisodic(
    namespaceId,
    "In June 2026 Steve met Gumi in Chiang Mai and started working at Two Way as CTO after a hiking meetup.",
    "2026-06-14T10:00:00Z",
    { benchmark_case: "chiang_mai_exact_temporal" }
  );
  await insertEpisodic(
    namespaceId,
    "Stephen Park handled the summer home repair plan near Tahoe in August 2026 and coordinated the cabin access list.",
    "2026-08-09T09:15:00Z",
    { benchmark_case: "alias_collision_stephen" }
  );
  await insertEpisodic(
    namespaceId,
    "Steven Park handled the Project Atlas design review in August 2026 and discussed rollout risks for the dashboard.",
    "2026-08-11T15:45:00Z",
    { benchmark_case: "alias_collision_steven" }
  );
  await insertEpisodic(
    namespaceId,
    "On March 12 2025 the redesign notes focused on the dashboard timeline UX and the relationship graph layout for the AI brain.",
    "2025-03-12T14:20:00Z",
    { benchmark_case: "march_redesign_date" }
  );
  await insertEpisodic(
    namespaceId,
    "Sara Alvarez joined the Kyoto dinner in April 2025 to discuss itinerary swaps and transit planning.",
    "2025-04-18T19:30:00Z",
    { benchmark_case: "entity_collision_sara" }
  );
  await insertRelationshipMemory(namespaceId, "Steve", "lives_in", "Chiang Mai", "place", "2026-03-18T00:00:00Z", 0.95);
  await insertRelationshipMemory(namespaceId, "Steve", "lives_in", "Thailand", "place", "2026-03-18T00:00:00Z", 0.81);
  await insertSemantic(
    namespaceId,
    "CVE-2026-3172 is the tracked buffer overflow in the gateway parser and remains open for hardening.",
    101,
    "2026-02-01T10:00:00Z",
    { benchmark_case: "rare_entity_cve" }
  );
  await insertSemantic(
    namespaceId,
    "pgvector 0.8.2 release notes mention sparsevec improvements and iterative index scans relevant to hybrid retrieval.",
    117,
    "2026-01-14T09:00:00Z",
    { benchmark_case: "version_precision_pgvector" }
  );
  await insertSemantic(
    namespaceId,
    "SQS DLQ setup requires a dead-letter queue redrive policy and explicit retry visibility timeouts.",
    131,
    "2026-02-18T11:00:00Z",
    { benchmark_case: "acronym_precision_sqs_dlq" }
  );
  const oldCoffeeId = await insertProcedural(
    namespaceId,
    "preference",
    "coffee brew method",
    { target: "coffee brew method", value: "French press" },
    "2025-01-10T08:00:00Z",
    "2025-11-30T23:59:59Z",
    1
  );
  await insertProcedural(
    namespaceId,
    "preference",
    "coffee brew method",
    { target: "coffee brew method", value: "pour over" },
    "2025-12-01T08:00:00Z",
    null,
    2,
    oldCoffeeId
  );
  await insertArtifactDerivation(
    namespaceId,
    "benchmark://server-screenshot.png",
    "sha256-server-port-3000",
    "2026-03-01T12:00:00Z",
    "ocr_text",
    "OCR from the server screenshot shows port 3000 and webhook receiver config for Discord and Slack.",
    { benchmark_case: "artifact_ocr_port" }
  );
  await insertArtifactDerivation(
    namespaceId,
    "benchmark://design-packet.png",
    "c6b7e8-benchmark-hash",
    "2026-03-01T13:00:00Z",
    "text_proxy",
    "Artifact hash c6b7e8 points to the retained March 2025 redesign packet with provenance markers and source tracking.",
    { benchmark_case: "provenance_hash_lookup" }
  );

  await runTemporalSummaryScaffold(namespaceId, {
    layer: "day",
    lookbackDays: 800,
    maxMembersPerNode: 500
  });
  await runTemporalSummaryScaffold(namespaceId, {
    layer: "week",
    lookbackDays: 800,
    maxMembersPerNode: 500
  });
  await runTemporalSummaryScaffold(namespaceId, {
    layer: "month",
    lookbackDays: 800,
    maxMembersPerNode: 500
  });
  await runTemporalSummaryScaffold(namespaceId, {
    layer: "year",
    lookbackDays: 800,
    maxMembersPerNode: 500
  });
}

async function runOne(
  provider: "fts" | "bm25",
  namespaceId: string,
  testCase: BenchmarkCase
): Promise<BenchmarkCaseResult> {
  const previous = process.env.BRAIN_LEXICAL_PROVIDER;
  process.env.BRAIN_LEXICAL_PROVIDER = provider;

  try {
    const response = await searchMemory({
      namespaceId,
      query: testCase.query,
      timeStart: testCase.timeStart,
      timeEnd: testCase.timeEnd,
      limit: 5
    });

    const top = response.results[0];
    const topContent = top?.content ?? "";
    const effectiveTimeStart = testCase.timeStart ?? response.meta.planner.inferredTimeStart;
    const effectiveTimeEnd = testCase.timeEnd ?? response.meta.planner.inferredTimeEnd;
    const topOverlap = computeTopWindowOverlap(top, effectiveTimeStart, effectiveTimeEnd);
    const approxTokens = approxTokenCount(response.results.map((item) => item.content).join(" "));
    const failureReasons: string[] = [];

    if (testCase.expectZeroResults) {
      if (response.results.length !== 0) {
        failureReasons.push(`expected 0 results, got ${response.results.length}`);
      }
    } else {
      if (!top) {
        failureReasons.push("expected a top result");
      }

      if (testCase.expectTopMemoryType && top?.memoryType !== testCase.expectTopMemoryType) {
        failureReasons.push(`expected top memory type ${testCase.expectTopMemoryType}, got ${top?.memoryType ?? "none"}`);
      }

      if (testCase.expectTopMemoryTypes && !testCase.expectTopMemoryTypes.includes(top?.memoryType ?? "")) {
        failureReasons.push(`expected top memory type in [${testCase.expectTopMemoryTypes.join(", ")}], got ${top?.memoryType ?? "none"}`);
      }

      for (const term of testCase.expectTopIncludes ?? []) {
        if (!topContent.toLowerCase().includes(term.toLowerCase())) {
          failureReasons.push(`top result missing term: ${term}`);
        }
      }

      for (const term of testCase.rejectTopIncludes ?? []) {
        if (topContent.toLowerCase().includes(term.toLowerCase())) {
          failureReasons.push(`top result unexpectedly included term: ${term}`);
        }
      }
    }

    if (typeof testCase.maxApproxTokens === "number" && approxTokens > testCase.maxApproxTokens) {
      failureReasons.push(`approx tokens ${approxTokens} exceeded ${testCase.maxApproxTokens}`);
    }

    if (typeof testCase.maxResultCount === "number" && response.results.length > testCase.maxResultCount) {
      failureReasons.push(`result count ${response.results.length} exceeded ${testCase.maxResultCount}`);
    }

    if (typeof testCase.expectTopOverlapMin === "number") {
      if (typeof topOverlap !== "number" || topOverlap < testCase.expectTopOverlapMin) {
        failureReasons.push(`top overlap ${typeof topOverlap === "number" ? topOverlap.toFixed(3) : "n/a"} below ${testCase.expectTopOverlapMin}`);
      }
    }

    return {
      name: testCase.name,
      provider,
      passed: failureReasons.length === 0,
      resultCount: response.results.length,
      effectiveLexicalProvider: response.meta.lexicalProvider,
      lexicalFallbackUsed: response.meta.lexicalFallbackUsed,
      lexicalFallbackReason: response.meta.lexicalFallbackReason,
      topMemoryType: top?.memoryType,
      topContent,
      topOverlap,
      approxTokens,
      failureReasons
    };
  } finally {
    if (previous === undefined) {
      delete process.env.BRAIN_LEXICAL_PROVIDER;
    } else {
      process.env.BRAIN_LEXICAL_PROVIDER = previous;
    }
  }
}

function compareCaseResults(report: readonly BenchmarkCaseResult[], provider: "fts" | "bm25"): number {
  return report.filter((item) => item.provider === provider && item.passed).length;
}

function tokenSum(report: readonly BenchmarkCaseResult[], provider: "fts" | "bm25"): number {
  return report
    .filter((item) => item.provider === provider)
    .map((item) => item.approxTokens)
    .reduce((sum, value) => sum + value, 0);
}

function toMarkdown(report: LexicalBenchmarkReport): string {
  const lines: string[] = [
    "# Lexical Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Baseline Eval Passed: ${report.baselineEvalPassed}`,
    "",
    "## Summary",
    "",
    `- FTS passed: ${report.summary.ftsPassed}/${report.summary.totalCases}`,
    `- BM25 passed: ${report.summary.bm25Passed}/${report.summary.totalCases}`,
    `- BM25 token delta: ${report.summary.bm25TokenDelta}`,
    `- BM25 fallback cases: ${report.summary.bm25FallbackCases}`,
    `- Recommendation: ${report.summary.recommendation}`,
    `- Reason: ${report.summary.reason}`,
    "",
    "## Cases",
    ""
  ];

  for (const item of report.cases) {
    lines.push(`### ${item.name} (${item.provider})`);
    lines.push(`- Passed: ${item.passed}`);
    lines.push(`- Result count: ${item.resultCount}`);
    lines.push(`- Effective lexical provider: ${item.effectiveLexicalProvider}`);
    lines.push(`- Lexical fallback used: ${item.lexicalFallbackUsed}`);
    lines.push(`- Top memory type: ${item.topMemoryType ?? "n/a"}`);
    lines.push(`- Top overlap: ${typeof item.topOverlap === "number" ? item.topOverlap.toFixed(3) : "n/a"}`);
    lines.push(`- Approx tokens: ${item.approxTokens}`);
    lines.push(`- Top content: ${item.topContent ?? ""}`);
    if (item.lexicalFallbackReason) {
      lines.push(`- Lexical fallback reason: ${item.lexicalFallbackReason}`);
    }
    if (item.failureReasons.length > 0) {
      lines.push(`- Failures: ${item.failureReasons.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export async function runLexicalBenchmark(): Promise<LexicalBenchmarkReport> {
  const baseline = await runLocalEvaluation();
  const baselineFailures = baseline.checks.filter((item) => !item.passed).map((item) => item.name);
  await seedBenchmarkCorpus(baseline.namespaceId);
  const generatedAt = new Date().toISOString();
  const cases: BenchmarkCaseResult[] = [];

  for (const testCase of BENCHMARK_CASES) {
    cases.push(await runOne("fts", baseline.namespaceId, testCase));
    cases.push(await runOne("bm25", baseline.namespaceId, testCase));
  }

  const ftsPassed = compareCaseResults(cases, "fts");
  const bm25Passed = compareCaseResults(cases, "bm25");
  const ftsTokens = tokenSum(cases, "fts");
  const bm25Tokens = tokenSum(cases, "bm25");
  const bm25TokenDelta = bm25Tokens - ftsTokens;
  const bm25FallbackCases = cases.filter((item) => item.provider === "bm25" && item.lexicalFallbackUsed).length;
  const recommendation =
    baselineFailures.length === 0 &&
    BENCHMARK_CASES.length >= 10 &&
    bm25Passed === BENCHMARK_CASES.length &&
    bm25Passed >= ftsPassed &&
    bm25TokenDelta <= 25 &&
    bm25FallbackCases === 0
      ? "candidate_for_default"
      : "keep_feature_gated";

  const reason =
    recommendation === "candidate_for_default"
      ? "BM25 matched or exceeded FTS across the expanded lexical stress suite with zero fallback and only a small acceptable token overhead."
      : "Keep BM25 behind a flag until it clears the expanded lexical stress suite, baseline eval remains clean, BM25 fallback frequency reaches zero, and its token overhead stays within an acceptable range.";

  return {
    generatedAt,
    namespaceId: baseline.namespaceId,
    baselineEvalPassed: baselineFailures.length === 0,
    baselineEvalFailures: baselineFailures,
    cases,
    summary: {
      ftsPassed,
      bm25Passed,
      totalCases: BENCHMARK_CASES.length,
      bm25TokenDelta,
      bm25FallbackCases,
      recommendation,
      reason
    }
  };
}

export async function writeLexicalBenchmarkReport(report: LexicalBenchmarkReport): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
}> {
  const outputDir = defaultOutputDir();
  await mkdir(outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `lexical-benchmark-${stamp}.json`);
  const markdownPath = path.join(outputDir, `lexical-benchmark-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "latest.md"), toMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

export async function runAndWriteLexicalBenchmark(): Promise<{
  readonly report: LexicalBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runLexicalBenchmark();
    const output = await writeLexicalBenchmarkReport(report);
    return {
      report,
      output
    };
  } finally {
    await closePool();
  }
}
