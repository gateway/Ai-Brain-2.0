import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { runOmiLatestSync } from "./omi-latest-sync.js";
import { payloadEvidenceCount, queryTimeModelCallsFromPayload } from "./query-benchmark-utils.js";

type McpToolName = "memory.search" | "memory.extract_tasks" | "memory.extract_calendar";
type Corpus = "omi" | "longmem" | "locomo" | "codex" | "pdf_docs";

interface AuditSeed {
  readonly id: string;
  readonly corpus: Corpus;
  readonly namespaceId: string;
  readonly toolName: McpToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly referenceNow?: string;
}

interface AuditRow {
  readonly id: string;
  readonly seedId: string;
  readonly corpus: Corpus;
  readonly namespaceId: string;
  readonly toolName: McpToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly rating: number;
  readonly quality: "strong" | "weak" | "fail";
  readonly residualOwner:
    | "none"
    | "missing_expected_terms"
    | "no_evidence"
    | "empty_source_trail"
    | "missing_claim_audit"
    | "query_time_model_call"
    | "tool_error";
  readonly notes: string;
  readonly passed: boolean;
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

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasTerm(value: string, term: string): boolean {
  return ` ${normalizeComparable(value)} `.includes(` ${normalizeComparable(term)} `);
}

function answerPreview(payload: any): string {
  const answer = String(payload?.humanReadable?.answer ?? payload?.answer ?? payload?.summaryText ?? payload?.duality?.claim?.text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return answer.length > 700 ? `${answer.slice(0, 699)}…` : answer;
}

function sourceTrailEntries(payload: any): readonly any[] {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail : [];
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.sourceTrail) ? task.sourceTrail : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((commitment: any) => (Array.isArray(commitment?.sourceTrail) ? commitment.sourceTrail : []))
    : [];
  return [...topLevel, ...tasks, ...commitments];
}

function claimAuditCount(payload: any): number {
  if (Array.isArray(payload?.claimAudit)) {
    return payload.claimAudit.length;
  }
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks.flatMap((task: any) => (Array.isArray(task?.claimAudit) ? task.claimAudit : [])) : [];
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.flatMap((commitment: any) => (Array.isArray(commitment?.claimAudit) ? commitment.claimAudit : []))
    : [];
  return tasks.length + commitments.length;
}

function expectedTermsForPhrase(phrase: string): readonly string[] {
  const stopwords = new Set(["the", "and", "with", "from", "that", "this", "then", "they", "also", "need", "needs", "after", "before"]);
  return [
    ...new Set(
      normalizeComparable(phrase)
        .split(" ")
        .filter((token) => token.length >= 4 && !stopwords.has(token))
        .slice(0, 4)
    )
  ];
}

function rawOmiPathForNormalizedPath(normalizedPath: string): string {
  return normalizedPath.replace("/normalized/", "/raw/").replace(/\.md$/u, ".json");
}

async function latestOmiTaskExpectedTerms(namespaceId = "personal"): Promise<readonly string[]> {
  const sync = await runOmiLatestSync({ namespaceId, skipCompiler: true });
  const rawPath = rawOmiPathForNormalizedPath(sync.report.latestFile.absolutePath);
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as {
    readonly structured?: { readonly action_items?: readonly { readonly description?: string | null }[] } | null;
  };
  const firstActionItem = raw.structured?.action_items?.find((item) => typeof item.description === "string" && item.description.trim().length > 0);
  return firstActionItem ? expectedTermsForPhrase(firstActionItem.description ?? "") : ["task"];
}

function queryVariants(query: string): readonly string[] {
  const compact = query.replace(/[?.!]+$/u, "");
  const lowerFirst = compact.charAt(0).toLowerCase() + compact.slice(1);
  return [
    query,
    `Give me the short version: ${compact}.`,
    `${compact}. Please include source-backed support.`,
    `In plain English, ${lowerFirst}?`
  ];
}

async function latestPublicMemoryNamespace(params: {
  readonly sourceDataset: "longmemeval" | "locomo";
  readonly keyName: "question_id" | "sample_id";
  readonly keyValue: string;
}): Promise<string> {
  const rows = await queryRows<{ readonly namespace_id: string }>(
    `
      SELECT namespace_id
      FROM artifacts
      WHERE metadata->>'source_dataset' = $1
        AND metadata->>$2 = $3
      GROUP BY namespace_id
      ORDER BY max(created_at) DESC
      LIMIT 1
    `,
    [params.sourceDataset, params.keyName, params.keyValue]
  );
  const namespaceId = rows[0]?.namespace_id;
  if (!namespaceId) {
    throw new Error(`No prepared ${params.sourceDataset} namespace found for ${params.keyName}=${params.keyValue}. Run retrieval-question-audit or the public-memory fixture pack first.`);
  }
  return namespaceId;
}

async function buildFixtureNamespaces(): Promise<{
  readonly longmem: Record<string, string>;
  readonly locomo: Record<string, string>;
}> {
  const longmemIds = ["118b2229", "58bf7951", "e01b8e2f"] as const;
  const locomoIds = ["conv-26", "conv-30", "conv-44", "conv-50"] as const;
  const longmem: Record<string, string> = {};
  const locomo: Record<string, string> = {};
  for (const id of longmemIds) {
    longmem[id] = await latestPublicMemoryNamespace({ sourceDataset: "longmemeval", keyName: "question_id", keyValue: id });
  }
  for (const id of locomoIds) {
    locomo[id] = await latestPublicMemoryNamespace({ sourceDataset: "locomo", keyName: "sample_id", keyValue: id });
  }
  return { longmem, locomo };
}

async function buildSeeds(): Promise<{ readonly seeds: readonly AuditSeed[]; readonly setupArtifacts: Record<string, string> }> {
  const fixtureNamespaces = await buildFixtureNamespaces();
  const multiSource = await runAndWriteMultiSourceIngestionPack();
  const latestOmiTerms = await latestOmiTaskExpectedTerms();
  const seeds: readonly AuditSeed[] = [
    {
      id: "omi_chiang_mai_friends",
      corpus: "omi",
      namespaceId: "personal",
      toolName: "memory.search",
      query: "Who are my friends in Chiang Mai?",
      expectedTerms: ["Dan", "Gummi", "Tim", "Ben", "Chiang Mai"]
    },
    {
      id: "omi_july_travel",
      corpus: "omi",
      namespaceId: "personal",
      toolName: "memory.extract_calendar",
      query: "What trips did I mention for mid to late July?",
      expectedTerms: ["July", "US"]
    },
    {
      id: "omi_latest_tasks",
      corpus: "omi",
      namespaceId: "personal",
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention in my most recent OMI note?",
      expectedTerms: latestOmiTerms
    },
    {
      id: "omi_active_projects",
      corpus: "omi",
      namespaceId: "personal",
      toolName: "memory.search",
      query: "What project am I actively focused on right now?",
      expectedTerms: ["Two Way", "Well Inked", "Preset Kitchen", "AI Brain"]
    },
    {
      id: "omi_id_software",
      corpus: "omi",
      namespaceId: "personal",
      toolName: "memory.search",
      query: "What did I do when I worked with id Software and John Carmack?",
      expectedTerms: ["id Software", "John Carmack"]
    },
    {
      id: "longmem_commute",
      corpus: "longmem",
      namespaceId: fixtureNamespaces.longmem["118b2229"]!,
      toolName: "memory.search",
      query: "How long is my daily commute to work?",
      expectedTerms: ["45 minutes"]
    },
    {
      id: "longmem_play",
      corpus: "longmem",
      namespaceId: fixtureNamespaces.longmem["58bf7951"]!,
      toolName: "memory.search",
      query: "What play did I attend at the local community theater?",
      expectedTerms: ["The Glass Menagerie"]
    },
    {
      id: "longmem_family_trip",
      corpus: "longmem",
      namespaceId: fixtureNamespaces.longmem["e01b8e2f"]!,
      toolName: "memory.search",
      query: "Where did I go on a week-long trip with my family?",
      expectedTerms: ["Hawaii"]
    },
    {
      id: "longmem_commute_alt",
      corpus: "longmem",
      namespaceId: fixtureNamespaces.longmem["118b2229"]!,
      toolName: "memory.search",
      query: "How much time should I expect for my work commute each day?",
      expectedTerms: ["45 minutes"]
    },
    {
      id: "longmem_play_alt",
      corpus: "longmem",
      namespaceId: fixtureNamespaces.longmem["58bf7951"]!,
      toolName: "memory.search",
      query: "Which local theater performance did I go see?",
      expectedTerms: ["The Glass Menagerie"]
    },
    {
      id: "locomo_support_group",
      corpus: "locomo",
      namespaceId: fixtureNamespaces.locomo["conv-26"]!,
      toolName: "memory.search",
      query: "When did Caroline go to the LGBTQ support group?",
      expectedTerms: ["7 May 2023"]
    },
    {
      id: "locomo_jon_causal",
      corpus: "locomo",
      namespaceId: fixtureNamespaces.locomo["conv-30"]!,
      toolName: "memory.search",
      query: "Why did Jon decide to start his dance studio?",
      expectedTerms: ["lost", "passion", "share"]
    },
    {
      id: "locomo_gina_causal",
      corpus: "locomo",
      namespaceId: fixtureNamespaces.locomo["conv-30"]!,
      toolName: "memory.search",
      query: "Why did Gina decide to start her own clothing store?",
      expectedTerms: ["fashion", "unique pieces", "lost her job"]
    },
    {
      id: "locomo_pastries",
      corpus: "locomo",
      namespaceId: fixtureNamespaces.locomo["conv-44"]!,
      toolName: "memory.search",
      query: "What kind of pastries did Andrew and his girlfriend have at the cafe?",
      expectedTerms: ["croissants", "muffins", "tarts"]
    },
    {
      id: "locomo_bands",
      corpus: "locomo",
      namespaceId: fixtureNamespaces.locomo["conv-50"]!,
      toolName: "memory.search",
      query: "Which bands has Dave enjoyed listening to?",
      expectedTerms: ["Aerosmith", "The Fireworks"]
    },
    {
      id: "codex_media_pricing",
      corpus: "codex",
      namespaceId: "codex_media_studio_backfill_20260526_01",
      toolName: "memory.search",
      query: "For the media app, what did we decide about estimated pricing and the KIE pricing boundary?",
      expectedTerms: ["estimated-pricing", "KIE", "pricing"],
      referenceNow: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "codex_media_duplicate_tabs",
      corpus: "codex",
      namespaceId: "codex_media_studio_backfill_20260526_01",
      toolName: "memory.search",
      query: "What happened with duplicate New workflow tabs in Media Studio?",
      expectedTerms: ["duplicate", "New workflow", "browser"],
      referenceNow: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "codex_ai_raw_curated",
      corpus: "codex",
      namespaceId: "codex_ai_brain_backfill_20260526_01",
      toolName: "memory.search",
      query: "What did we prove about raw transcripts versus curated Codex summaries in AI Brain?",
      expectedTerms: ["raw transcript", "curated", "embedding"],
      referenceNow: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "codex_ai_vector_sync",
      corpus: "codex",
      namespaceId: "codex_ai_brain_backfill_20260526_01",
      toolName: "memory.search",
      query: "What did AI Brain establish about vector sync for Codex session memory?",
      expectedTerms: ["vector", "sync"],
      referenceNow: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "codex_ai_agent_packet",
      corpus: "codex",
      namespaceId: "codex_ai_brain_backfill_20260526_01",
      toolName: "memory.search",
      query: "What should a future agent preload before working on AI Brain?",
      expectedTerms: ["curated summaries", "source trails"],
      referenceNow: "2026-05-27T00:00:00.000Z"
    },
    {
      id: "pdf_tasks",
      corpus: "pdf_docs",
      namespaceId: multiSource.report.namespaceId,
      toolName: "memory.extract_tasks",
      query: "What tasks did I mention across notes, PDFs, and task exports this week?",
      expectedTerms: ["Schema-Grounded Memory PDF", "document chunking fixture", "Phase 14 retrieval spec"],
      referenceNow: "2026-05-23T08:30:00.000Z"
    },
    {
      id: "pdf_calendar",
      corpus: "pdf_docs",
      namespaceId: multiSource.report.namespaceId,
      toolName: "memory.extract_calendar",
      query: "What travel or calendar commitments are in my notes and calendar exports for June 2026?",
      expectedTerms: ["Bangkok AI model meetup", "2026-06-15", "AI memory PDF review"],
      referenceNow: "2026-05-23T08:30:00.000Z"
    },
    {
      id: "pdf_ai_memory",
      corpus: "pdf_docs",
      namespaceId: multiSource.report.namespaceId,
      toolName: "memory.search",
      query: "What AI memory PDFs did I save for retrieval planning?",
      expectedTerms: ["Schema-Grounded Memory", "xMemory", "chunking"],
      referenceNow: "2026-05-23T08:30:00.000Z"
    },
    {
      id: "pdf_phase14_specs",
      corpus: "pdf_docs",
      namespaceId: multiSource.report.namespaceId,
      toolName: "memory.search",
      query: "What project specs mention Phase 14 retrieval planning across notes and PDFs?",
      expectedTerms: ["Phase 14", "retrieval planning", "source envelope"],
      referenceNow: "2026-05-23T08:30:00.000Z"
    },
    {
      id: "pdf_chunking",
      corpus: "pdf_docs",
      namespaceId: multiSource.report.namespaceId,
      toolName: "memory.search",
      query: "What did the saved documents say about hierarchical chunking and retrieval quality gates?",
      expectedTerms: ["hierarchical chunking", "quality gates"],
      referenceNow: "2026-05-23T08:30:00.000Z"
    }
  ];
  return {
    seeds,
    setupArtifacts: {
      multiSourceIngestionArtifact: multiSource.output.jsonPath
    }
  };
}

function classifyRow(params: {
  readonly missingTerms: readonly string[];
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly toolError: boolean;
}): Pick<AuditRow, "quality" | "residualOwner" | "passed" | "rating" | "notes"> {
  if (params.toolError) return { quality: "fail", residualOwner: "tool_error", passed: false, rating: 1, notes: "The MCP tool call failed." };
  if (params.queryTimeModelCalls > 0) {
    return { quality: "fail", residualOwner: "query_time_model_call", passed: false, rating: 2, notes: "Retrieval used a query-time model call." };
  }
  if (params.evidenceCount <= 0) return { quality: "fail", residualOwner: "no_evidence", passed: false, rating: 2, notes: "No support evidence was returned." };
  if (params.sourceTrailCount <= 0) {
    return { quality: "weak", residualOwner: "empty_source_trail", passed: false, rating: 5, notes: "Evidence exists but source trail is empty." };
  }
  if (params.claimAuditCount <= 0) {
    return { quality: "weak", residualOwner: "missing_claim_audit", passed: false, rating: 6, notes: "Evidence exists but claim audit is missing." };
  }
  if (params.missingTerms.length > 0) {
    return { quality: "weak", residualOwner: "missing_expected_terms", passed: false, rating: 7, notes: "Supported answer missed expected source terms." };
  }
  return { quality: "strong", residualOwner: "none", passed: true, rating: 10, notes: "Source-backed answer preserved expected terms, source trail, and claim audit." };
}

async function runAuditRow(seed: AuditSeed, variantIndex: number, query: string): Promise<AuditRow> {
  const startedAt = performance.now();
  try {
    const wrapped = (await executeMcpTool(seed.toolName, {
      namespace_id: seed.namespaceId,
      query,
      limit: 10,
      detail_mode: "compact",
      detailMode: "compact",
      reference_now: seed.referenceNow
    })) as { readonly structuredContent?: any };
    const payload = wrapped.structuredContent ?? {};
    const serialized = JSON.stringify(payload);
    const missingTerms = seed.expectedTerms.filter((term) => !hasTerm(serialized, term));
    const evidenceCount = payloadEvidenceCount(payload);
    const sourceTrailCount = sourceTrailEntries(payload).length;
    const auditCount = claimAuditCount(payload);
    const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
    const classification = classifyRow({
      missingTerms,
      evidenceCount,
      sourceTrailCount,
      claimAuditCount: auditCount,
      queryTimeModelCalls,
      toolError: false
    });
    return {
      id: `${seed.id}_v${variantIndex + 1}`,
      seedId: seed.id,
      corpus: seed.corpus,
      namespaceId: seed.namespaceId,
      toolName: seed.toolName,
      query,
      expectedTerms: seed.expectedTerms,
      missingTerms,
      finalClaimSource:
        typeof payload?.finalClaimSource === "string"
          ? payload.finalClaimSource
          : typeof payload?.meta?.finalClaimSource === "string"
            ? payload.meta.finalClaimSource
            : null,
      queryContract:
        typeof payload?.queryContract === "string"
          ? payload.queryContract
          : typeof payload?.meta?.queryContractName === "string"
            ? payload.meta.queryContractName
            : null,
      retrievalDomain:
        typeof payload?.retrievalDomain === "string"
          ? payload.retrievalDomain
          : typeof payload?.meta?.retrievalDomain === "string"
            ? payload.meta.retrievalDomain
            : null,
      evidenceCount,
      sourceTrailCount,
      claimAuditCount: auditCount,
      queryTimeModelCalls,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: answerPreview(payload),
      ...classification
    };
  } catch (error) {
    return {
      id: `${seed.id}_v${variantIndex + 1}`,
      seedId: seed.id,
      corpus: seed.corpus,
      namespaceId: seed.namespaceId,
      toolName: seed.toolName,
      query,
      expectedTerms: seed.expectedTerms,
      missingTerms: seed.expectedTerms,
      finalClaimSource: null,
      queryContract: null,
      retrievalDomain: null,
      evidenceCount: 0,
      sourceTrailCount: 0,
      claimAuditCount: 0,
      queryTimeModelCalls: 0,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: error instanceof Error ? error.message : String(error),
      quality: "fail",
      residualOwner: "tool_error",
      rating: 1,
      notes: "The MCP tool call failed.",
      passed: false
    };
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number((sorted[Math.ceil(sorted.length * p) - 1] ?? 0).toFixed(2));
}

function metricsFromRows(rows: readonly AuditRow[]): Record<string, unknown> {
  const corpusBreakdown = Object.fromEntries(
    [...new Set(rows.map((row) => row.corpus))].sort().map((corpus) => {
      const subset = rows.filter((row) => row.corpus === corpus);
      return [
        corpus,
        {
          total: subset.length,
          strong: subset.filter((row) => row.quality === "strong").length,
          weak: subset.filter((row) => row.quality === "weak").length,
          fail: subset.filter((row) => row.quality === "fail").length,
          averageRating: Number((subset.reduce((sum, row) => sum + row.rating, 0) / Math.max(1, subset.length)).toFixed(2))
        }
      ];
    })
  );
  const latencies = rows.map((row) => row.latencyMs);
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    failCount: rows.filter((row) => row.quality === "fail").length,
    averageRating: Number((rows.reduce((sum, row) => sum + row.rating, 0) / Math.max(1, rows.length)).toFixed(2)),
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: Math.max(...latencies),
    corpusBreakdown,
    residualOwnerCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function toMarkdown(report: any): string {
  const lines = [
    "# Cross-Corpus MCP Query Audit 100",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- strong/weak/fail: ${report.metrics.strongCount}/${report.metrics.weakCount}/${report.metrics.failCount}`,
    `- averageRating: ${report.metrics.averageRating}/10`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Corpus Ratings",
    "",
    ...Object.entries(report.metrics.corpusBreakdown).map(([corpus, value]: [string, any]) => {
      return `- ${corpus}: ${value.strong}/${value.weak}/${value.fail}, average ${value.averageRating}/10`;
    }),
    "",
    "## Weak Or Failed Rows",
    "",
    ...report.results
      .filter((row: AuditRow) => row.quality !== "strong")
      .map((row: AuditRow) => `- ${row.id}: rating=${row.rating}/10 owner=${row.residualOwner} missing=${row.missingTerms.join("|") || "none"} query=${row.query}`),
    ...(report.results.every((row: AuditRow) => row.quality === "strong") ? ["- None."] : []),
    "",
    "## All Results",
    "",
    ...report.results.map(
      (row: AuditRow) =>
        `- ${row.id} [${row.corpus}] rating=${row.rating}/10 quality=${row.quality} final=${row.finalClaimSource ?? "unknown"} evidence=${row.evidenceCount} sources=${row.sourceTrailCount} audit=${row.claimAuditCount} query="${row.query}" answer="${row.answerPreview}"`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteCrossCorpusMcpQueryAudit100(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const { seeds, setupArtifacts } = await buildSeeds();
  const rows: AuditRow[] = [];
  for (const seed of seeds) {
    const variants = queryVariants(seed.query);
    for (let index = 0; index < variants.length; index += 1) {
      rows.push(await runAuditRow(seed, index, variants[index]!));
    }
  }
  const generatedAt = new Date().toISOString();
  const metrics = metricsFromRows(rows);
  const report = {
    generatedAt,
    benchmark: "cross_corpus_mcp_query_audit_100",
    artifactSchemaVersion: "cross_corpus_mcp_query_audit_100_v1",
    passed:
      rows.length === 100 &&
      metrics.weakCount === 0 &&
      metrics.failCount === 0 &&
      metrics.missingExpectedTermRows === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.queryTimeModelCalls === 0,
    setupArtifacts,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `cross-corpus-mcp-query-audit-100-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `cross-corpus-mcp-query-audit-100-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runCrossCorpusMcpQueryAudit100Cli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteCrossCorpusMcpQueryAudit100();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}
