import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteMultiSourceIngestionPack } from "./multi-source-ingestion-pack.js";
import { PERSONAL_OMI_HARD_QUERY_SCENARIOS, type PersonalOmiHardQueryScenario } from "./personal-omi-hard-query-audit-30.js";
import { hasTerm, payloadEvidenceCount, percentile, queryTimeModelCallsFromPayload, rate } from "./query-benchmark-utils.js";

type ToolName = "memory.search" | "memory.extract_calendar" | "memory.extract_tasks" | "memory.recap";
type Corpus = "personal" | "longmem" | "locomo" | "codex" | "docs_ocr_pdf";
type Quality = "strong" | "acceptable" | "weak" | "fail" | "source_missing";
type ResidualOwner =
  | "none"
  | "planner_intent_miss"
  | "wrong_corpus"
  | "scope_leak"
  | "source_missing"
  | "missing_expected_terms"
  | "empty_source_trail"
  | "missing_claim_audit"
  | "query_time_model_call"
  | "tool_error";

interface LiveAuditSeed {
  readonly id: string;
  readonly corpus: Corpus;
  readonly namespaceId: string;
  readonly toolName: ToolName;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms?: readonly string[];
  readonly expectedQueryContract?: string;
  readonly expectedFinalClaimSource?: string;
  readonly allowSourceMissing?: boolean;
  readonly referenceNow?: string;
}

interface LiveAuditRow extends LiveAuditSeed {
  readonly rowId: string;
  readonly variantIndex: number;
  readonly finalQuery: string;
  readonly finalClaimSource: string | null;
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly selectedIntent: string | null;
  readonly selectedCorpus: string | null;
  readonly selectedReader: string | null;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly answerPreview: string;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly quality: Quality;
  readonly rating: number;
  readonly residualOwner: ResidualOwner;
  readonly passed: boolean;
  readonly notes: string;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function queryVariants(query: string): readonly string[] {
  const compact = query.replace(/[?.!]+$/u, "");
  return [query, `Give me the short version: ${compact}.`, `${compact}. Please include source-backed support.`];
}

function payloadAnswerPreview(payload: any, toolName: ToolName): string {
  if (typeof payload?.humanReadable?.answer === "string") return payload.humanReadable.answer;
  if (typeof payload?.answer === "string") return payload.answer;
  if (typeof payload?.summaryText === "string") return payload.summaryText;
  if (typeof payload?.duality?.claim?.text === "string") return payload.duality.claim.text;
  if (toolName === "memory.extract_tasks" && Array.isArray(payload?.tasks)) {
    return payload.tasks.map((task: any) => task?.title ?? task?.text ?? "").filter(Boolean).join("; ");
  }
  if (toolName === "memory.extract_calendar" && Array.isArray(payload?.commitments)) {
    return payload.commitments.map((commitment: any) => commitment?.title ?? commitment?.text ?? "").filter(Boolean).join("; ");
  }
  return "";
}

function sourceTrailCount(payload: any): number {
  const topLevel = Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
  const sections = Array.isArray(payload?.answerSections)
    ? payload.answerSections.reduce((sum: number, section: any) => sum + (Array.isArray(section?.sourceTrail) ? section.sourceTrail.length : 0), 0)
    : 0;
  const tasks = Array.isArray(payload?.tasks)
    ? payload.tasks.reduce((sum: number, task: any) => sum + (Array.isArray(task?.sourceTrail) ? task.sourceTrail.length : 0), 0)
    : 0;
  const commitments = Array.isArray(payload?.commitments)
    ? payload.commitments.reduce((sum: number, commitment: any) => sum + (Array.isArray(commitment?.sourceTrail) ? commitment.sourceTrail.length : 0), 0)
    : 0;
  return topLevel + sections + tasks + commitments;
}

function claimAuditCount(payload: any): number {
  const topLevel = Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
  const sections = Array.isArray(payload?.answerSections)
    ? payload.answerSections.reduce((sum: number, section: any) => sum + (Array.isArray(section?.claimAudit) ? section.claimAudit.length : 0), 0)
    : 0;
  return topLevel + sections;
}

function liveEvidenceCount(payload: any): number {
  const base = payloadEvidenceCount(payload);
  if (base > 0) return base;
  if (Array.isArray(payload?.commitments) && payload.commitments.length > 0) return payload.commitments.length;
  if (Array.isArray(payload?.answerSections)) {
    const sectionEvidence = payload.answerSections.reduce((sum: number, section: any) => {
      if (typeof section?.evidenceCount === "number") return sum + section.evidenceCount;
      if (Array.isArray(section?.sourceTrail)) return sum + section.sourceTrail.length;
      return sum;
    }, 0);
    if (sectionEvidence > 0) return sectionEvidence;
  }
  if (Array.isArray(payload?.sourceTrail) && payload.sourceTrail.length > 0) return payload.sourceTrail.length;
  return 0;
}

function metaFromPayload(payload: any): Record<string, any> {
  if (typeof payload?.meta === "object" && payload.meta) return payload.meta;
  if (typeof payload?.retrievalPlan === "object" && payload.retrievalPlan) return payload.retrievalPlan;
  return {};
}

function finalClaimSource(payload: any): string | null {
  if (typeof payload?.finalClaimSource === "string") return payload.finalClaimSource;
  if (typeof payload?.meta?.finalClaimSource === "string") return payload.meta.finalClaimSource;
  return null;
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
    throw new Error(`No prepared ${params.sourceDataset} namespace found for ${params.keyName}=${params.keyValue}. Run the public-memory fixture pack first.`);
  }
  return namespaceId;
}

function personalSeeds(): readonly LiveAuditSeed[] {
  return PERSONAL_OMI_HARD_QUERY_SCENARIOS.map((scenario: PersonalOmiHardQueryScenario) => ({
    id: `personal_${scenario.id}`,
    corpus: "personal" as const,
    namespaceId: "personal",
    toolName: scenario.toolName,
    query: scenario.query,
    expectedTerms: scenario.expectedTerms,
    forbiddenTerms: scenario.forbiddenTerms,
    expectedQueryContract: scenario.expectedQueryContract,
    expectedFinalClaimSource: scenario.expectedFinalClaimSource,
    allowSourceMissing: scenario.allowSourceMissing
  }));
}

async function fixtureSeeds(): Promise<{ readonly seeds: readonly LiveAuditSeed[]; readonly setupArtifacts: Record<string, string> }> {
  const [longmemCommute, longmemPlay, longmemFamily, locomo26, locomo30, locomo44, locomo50, multiSource] = await Promise.all([
    latestPublicMemoryNamespace({ sourceDataset: "longmemeval", keyName: "question_id", keyValue: "118b2229" }),
    latestPublicMemoryNamespace({ sourceDataset: "longmemeval", keyName: "question_id", keyValue: "58bf7951" }),
    latestPublicMemoryNamespace({ sourceDataset: "longmemeval", keyName: "question_id", keyValue: "e01b8e2f" }),
    latestPublicMemoryNamespace({ sourceDataset: "locomo", keyName: "sample_id", keyValue: "conv-26" }),
    latestPublicMemoryNamespace({ sourceDataset: "locomo", keyName: "sample_id", keyValue: "conv-30" }),
    latestPublicMemoryNamespace({ sourceDataset: "locomo", keyName: "sample_id", keyValue: "conv-44" }),
    latestPublicMemoryNamespace({ sourceDataset: "locomo", keyName: "sample_id", keyValue: "conv-50" }),
    runAndWriteMultiSourceIngestionPack()
  ]);
  const docsNamespace = multiSource.report.namespaceId;
  return {
    setupArtifacts: {
      multiSourceIngestionArtifact: multiSource.output.jsonPath
    },
    seeds: [
      { id: "longmem_commute_duration", corpus: "longmem", namespaceId: longmemCommute, toolName: "memory.search", query: "How much time should I expect for my work commute each day?", expectedTerms: ["45 minutes"] },
      { id: "longmem_commute_source", corpus: "longmem", namespaceId: longmemCommute, toolName: "memory.search", query: "Where did the commute duration answer come from?", expectedTerms: ["commute", "45 minutes"], allowSourceMissing: true },
      { id: "longmem_theater_performance", corpus: "longmem", namespaceId: longmemPlay, toolName: "memory.search", query: "Which local theater performance did I go see?", expectedTerms: ["The Glass Menagerie"] },
      { id: "longmem_family_trip", corpus: "longmem", namespaceId: longmemFamily, toolName: "memory.search", query: "Where did I go on a week-long trip with my family?", expectedTerms: ["Hawaii"] },
      { id: "longmem_family_trip_short", corpus: "longmem", namespaceId: longmemFamily, toolName: "memory.search", query: "What was the family vacation destination?", expectedTerms: ["Hawaii"] },
      { id: "locomo_support_group", corpus: "locomo", namespaceId: locomo26, toolName: "memory.search", query: "When did Caroline go to the LGBTQ support group?", expectedTerms: ["7 May 2023"] },
      { id: "locomo_dance_studio_reason", corpus: "locomo", namespaceId: locomo30, toolName: "memory.search", query: "Why did Jon decide to start his dance studio?", expectedTerms: ["lost", "passion", "share"] },
      { id: "locomo_clothing_store_reason", corpus: "locomo", namespaceId: locomo30, toolName: "memory.search", query: "Why did Gina decide to start her own clothing store?", expectedTerms: ["fashion", "unique pieces", "lost her job"] },
      { id: "locomo_cafe_pastries", corpus: "locomo", namespaceId: locomo44, toolName: "memory.search", query: "What kind of pastries did Andrew and his girlfriend have at the cafe?", expectedTerms: ["croissants", "muffins", "tarts"] },
      { id: "locomo_dave_bands", corpus: "locomo", namespaceId: locomo50, toolName: "memory.search", query: "Which bands has Dave enjoyed listening to?", expectedTerms: ["Aerosmith", "The Fireworks"] },
      { id: "codex_media_pricing", corpus: "codex", namespaceId: "codex_media_studio_backfill_20260526_01", toolName: "memory.search", query: "For Media Studio, what did we decide about estimated pricing and the KIE pricing boundary?", expectedTerms: ["estimated-pricing", "KIE", "pricing"], referenceNow: "2026-05-27T00:00:00.000Z" },
      { id: "codex_duplicate_tabs", corpus: "codex", namespaceId: "codex_media_studio_backfill_20260526_01", toolName: "memory.search", query: "What happened with duplicate New workflow tabs in Media Studio?", expectedTerms: ["duplicate", "New workflow", "browser"], referenceNow: "2026-05-27T00:00:00.000Z" },
      { id: "codex_ai_curated_memory", corpus: "codex", namespaceId: "codex_ai_brain_backfill_20260526_01", toolName: "memory.search", query: "What did we prove about raw transcripts versus curated Codex summaries in AI Brain?", expectedTerms: ["raw transcript", "curated", "embedding"], referenceNow: "2026-05-27T00:00:00.000Z" },
      { id: "codex_ai_agent_packet", corpus: "codex", namespaceId: "codex_ai_brain_backfill_20260526_01", toolName: "memory.search", query: "What should a future agent preload before working on AI Brain?", expectedTerms: ["curated summaries", "source trails"], referenceNow: "2026-05-27T00:00:00.000Z" },
      { id: "codex_token_waste", corpus: "codex", namespaceId: "codex_ai_brain_backfill_20260526_01", toolName: "memory.search", query: "What token waste patterns are costing us the most in Codex sessions?", expectedTerms: ["token", "waste"], referenceNow: "2026-05-27T00:00:00.000Z" },
      { id: "docs_tasks", corpus: "docs_ocr_pdf", namespaceId: docsNamespace, toolName: "memory.extract_tasks", query: "What tasks did I mention across notes, PDFs, and task exports this week?", expectedTerms: ["Schema-Grounded Memory PDF", "document chunking fixture", "Phase 14 retrieval spec"], referenceNow: "2026-05-23T08:30:00.000Z" },
      { id: "docs_calendar", corpus: "docs_ocr_pdf", namespaceId: docsNamespace, toolName: "memory.extract_calendar", query: "What travel or calendar commitments are in my notes and calendar exports for June 2026?", expectedTerms: ["Bangkok AI model meetup", "2026-06-15", "AI memory PDF review"], referenceNow: "2026-05-23T08:30:00.000Z" },
      { id: "docs_ai_memory", corpus: "docs_ocr_pdf", namespaceId: docsNamespace, toolName: "memory.search", query: "What AI memory PDFs did I save for retrieval planning?", expectedTerms: ["Schema-Grounded Memory", "xMemory", "chunking"], referenceNow: "2026-05-23T08:30:00.000Z" },
      { id: "docs_phase14_specs", corpus: "docs_ocr_pdf", namespaceId: docsNamespace, toolName: "memory.search", query: "What project specs mention Phase 14 retrieval planning across notes and PDFs?", expectedTerms: ["Phase 14", "retrieval planning", "source envelope"], referenceNow: "2026-05-23T08:30:00.000Z" },
      { id: "docs_chunking_quality", corpus: "docs_ocr_pdf", namespaceId: docsNamespace, toolName: "memory.search", query: "What did the saved documents say about hierarchical chunking and retrieval quality gates?", expectedTerms: ["hierarchical chunking", "quality gates"], referenceNow: "2026-05-23T08:30:00.000Z" }
    ]
  };
}

async function buildSeeds(): Promise<{ readonly seeds: readonly LiveAuditSeed[]; readonly setupArtifacts: Record<string, string> }> {
  const fixture = await fixtureSeeds();
  const seeds = [...personalSeeds(), ...fixture.seeds];
  if (seeds.length !== 50) {
    throw new Error(`live operator audit expected 50 seeds, got ${seeds.length}`);
  }
  return { seeds, setupArtifacts: fixture.setupArtifacts };
}

function classifyRow(params: {
  readonly seed: LiveAuditSeed;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly toolError: boolean;
}): Pick<LiveAuditRow, "quality" | "rating" | "residualOwner" | "passed" | "notes"> {
  if (params.toolError) return { quality: "fail", rating: 1, residualOwner: "tool_error", passed: false, notes: "The MCP tool call failed." };
  if (params.queryTimeModelCalls > 0) return { quality: "fail", rating: 2, residualOwner: "query_time_model_call", passed: false, notes: "Retrieval used a query-time model call." };
  if (params.evidenceCount <= 0) {
    const sourceMissingAllowed = params.seed.allowSourceMissing === true;
    return {
      quality: "source_missing",
      rating: sourceMissingAllowed ? 8 : 2,
      residualOwner: sourceMissingAllowed ? "none" : "source_missing",
      passed: sourceMissingAllowed,
      notes: sourceMissingAllowed ? "Typed source-missing abstention is allowed for this row." : "No support evidence was returned."
    };
  }
  if (params.forbiddenHits.length > 0) return { quality: "weak", rating: 4, residualOwner: "scope_leak", passed: false, notes: "Answer leaked forbidden/out-of-scope terms." };
  if (params.sourceTrailCount <= 0) return { quality: "weak", rating: 5, residualOwner: "empty_source_trail", passed: false, notes: "Supported answer had no source trail." };
  if (params.claimAuditCount <= 0) return { quality: "weak", rating: 6, residualOwner: "missing_claim_audit", passed: false, notes: "Supported answer had no claim audit." };
  if (params.missingTerms.length > 0) return { quality: "weak", rating: 7, residualOwner: "missing_expected_terms", passed: false, notes: "Supported answer missed expected terms." };
  return { quality: "strong", rating: 10, residualOwner: "none", passed: true, notes: "Source-backed answer preserved expected terms, source trail, and claim audit." };
}

async function runRow(seed: LiveAuditSeed, variantIndex: number, finalQuery: string): Promise<LiveAuditRow> {
  const startedAt = performance.now();
  try {
    const wrapped = (await executeMcpTool(seed.toolName, {
      namespace_id: seed.namespaceId,
      query: finalQuery,
      limit: 10,
      detail_mode: "compact",
      detailMode: "compact",
      reference_now: seed.referenceNow
    })) as { readonly structuredContent?: any };
    const payload = wrapped.structuredContent ?? {};
    const meta = metaFromPayload(payload);
    const serialized = JSON.stringify(payload);
    const actualContract = typeof payload?.queryContract === "string" ? payload.queryContract : typeof meta.queryContractName === "string" ? meta.queryContractName : null;
    const actualFinalClaimSource = finalClaimSource(payload);
    const missingTerms = [
      ...seed.expectedTerms.filter((term) => !hasTerm(serialized, term)),
      ...(seed.expectedQueryContract && actualContract !== seed.expectedQueryContract ? [`queryContract:${seed.expectedQueryContract}`] : []),
      ...(seed.expectedFinalClaimSource && actualFinalClaimSource !== seed.expectedFinalClaimSource ? [`finalClaimSource:${seed.expectedFinalClaimSource}`] : [])
    ];
    const forbiddenHits = (seed.forbiddenTerms ?? []).filter((term) => hasTerm(serialized, term));
    const evidenceCount = liveEvidenceCount(payload);
    const trailCount = sourceTrailCount(payload);
    const auditCount = claimAuditCount(payload);
    const queryTimeModelCalls = queryTimeModelCallsFromPayload(payload);
    const classification = classifyRow({
      seed,
      missingTerms,
      forbiddenHits,
      evidenceCount,
      sourceTrailCount: trailCount,
      claimAuditCount: auditCount,
      queryTimeModelCalls,
      toolError: false
    });
    return {
      ...seed,
      rowId: `${seed.id}_v${variantIndex + 1}`,
      variantIndex,
      finalQuery,
      finalClaimSource: actualFinalClaimSource,
      queryContract: actualContract,
      retrievalDomain: typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : typeof meta.queryContractRetrievalDomain === "string" ? meta.queryContractRetrievalDomain : null,
      selectedIntent: typeof meta.memoryQueryPlanIntent === "string" ? meta.memoryQueryPlanIntent : null,
      selectedCorpus: typeof meta.selectedCorpusCapability === "string" ? meta.selectedCorpusCapability : null,
      selectedReader: typeof meta.selectedReader === "string" ? meta.selectedReader : null,
      evidenceCount,
      sourceTrailCount: trailCount,
      claimAuditCount: auditCount,
      queryTimeModelCalls,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: payloadAnswerPreview(payload, seed.toolName).replace(/\s+/gu, " ").slice(0, 700),
      missingTerms,
      forbiddenHits,
      ...classification
    };
  } catch (error) {
    return {
      ...seed,
      rowId: `${seed.id}_v${variantIndex + 1}`,
      variantIndex,
      finalQuery,
      finalClaimSource: null,
      queryContract: null,
      retrievalDomain: null,
      selectedIntent: null,
      selectedCorpus: null,
      selectedReader: null,
      evidenceCount: 0,
      sourceTrailCount: 0,
      claimAuditCount: 0,
      queryTimeModelCalls: 0,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      answerPreview: error instanceof Error ? error.message : String(error),
      missingTerms: seed.expectedTerms,
      forbiddenHits: [],
      quality: "fail",
      rating: 1,
      residualOwner: "tool_error",
      passed: false,
      notes: "The MCP tool call failed."
    };
  }
}

function metricsFromRows(rows: readonly LiveAuditRow[]) {
  const nonAllowedSourceMissingRows = rows.filter((row) => !(row.quality === "source_missing" && row.allowSourceMissing === true));
  const corpusBreakdown = Object.fromEntries(
    [...new Set(rows.map((row) => row.corpus))].sort().map((corpus) => {
      const subset = rows.filter((row) => row.corpus === corpus);
      return [
        corpus,
        {
          total: subset.length,
          strong: subset.filter((row) => row.quality === "strong").length,
          acceptable: subset.filter((row) => row.quality === "acceptable").length,
          weak: subset.filter((row) => row.quality === "weak").length,
          fail: subset.filter((row) => row.quality === "fail").length,
          sourceMissing: subset.filter((row) => row.quality === "source_missing").length,
          averageRating: Number((subset.reduce((sum, row) => sum + row.rating, 0) / Math.max(1, subset.length)).toFixed(2))
        }
      ];
    })
  );
  return {
    totalRows: rows.length,
    strongCount: rows.filter((row) => row.quality === "strong").length,
    acceptableCount: rows.filter((row) => row.quality === "acceptable").length,
    weakCount: rows.filter((row) => row.quality === "weak").length,
    failCount: rows.filter((row) => row.quality === "fail").length,
    sourceMissingCount: rows.filter((row) => row.quality === "source_missing").length,
    strongRate: rate(rows.filter((row) => row.quality === "strong").length, rows.length),
    passRate: rate(rows.filter((row) => row.passed).length, rows.length),
    nonAllowedSourceMissingPassRate: rate(nonAllowedSourceMissingRows.filter((row) => row.passed).length, nonAllowedSourceMissingRows.length),
    missingExpectedTermRows: rows.filter((row) => row.missingTerms.length > 0 && !(row.quality === "source_missing" && row.allowSourceMissing)).length,
    scopeLeakRows: rows.filter((row) => row.forbiddenHits.length > 0).length,
    supportedEmptySourceTrailRows: rows.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: rows.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
    maxLatencyMs: Math.max(0, ...rows.map((row) => row.latencyMs)),
    corpusBreakdown,
    residualOwnerCounts: rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.residualOwner] = (counts[row.residualOwner] ?? 0) + 1;
      return counts;
    }, {})
  };
}

function toMarkdown(report: any): string {
  const lines = [
    "# Live Operator Query Audit 150",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- strong/acceptable/weak/fail/sourceMissing: ${report.metrics.strongCount}/${report.metrics.acceptableCount}/${report.metrics.weakCount}/${report.metrics.failCount}/${report.metrics.sourceMissingCount}`,
    `- strongRate: ${report.metrics.strongRate}`,
    `- passRate: ${report.metrics.passRate}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    "",
    "## Corpus Breakdown",
    "",
    ...Object.entries(report.metrics.corpusBreakdown).map(([corpus, value]: [string, any]) => `- ${corpus}: strong=${value.strong}, acceptable=${value.acceptable}, weak=${value.weak}, fail=${value.fail}, sourceMissing=${value.sourceMissing}, avg=${value.averageRating}/10`),
    "",
    "## Weak / Failed / Source Missing Rows",
    "",
    ...report.results
      .filter((row: LiveAuditRow) => row.quality !== "strong")
      .map((row: LiveAuditRow) => `- ${row.rowId}: quality=${row.quality}, owner=${row.residualOwner}, missing=${row.missingTerms.join("|") || "none"}, query="${row.finalQuery}"`),
    ...(report.results.every((row: LiveAuditRow) => row.quality === "strong") ? ["- None."] : []),
    "",
    "## Examples",
    "",
    ...report.results
      .filter((row: LiveAuditRow) => row.quality === "strong")
      .slice(0, 12)
      .map((row: LiveAuditRow) => `- ${row.rowId} [${row.corpus}] ${row.rating}/10: "${row.finalQuery}" -> "${row.answerPreview}"`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteLiveOperatorQueryAudit150(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const { seeds, setupArtifacts } = await buildSeeds();
  const rows: LiveAuditRow[] = [];
  for (const seed of seeds) {
    const variants = queryVariants(seed.query);
    for (let index = 0; index < variants.length; index += 1) {
      process.stderr.write(`[live-operator-query-audit-150] running ${seed.id}_v${index + 1}\n`);
      rows.push(await runRow(seed, index, variants[index]!));
    }
  }
  const metrics = metricsFromRows(rows);
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "live_operator_query_audit_150",
    artifactSchemaVersion: "live_operator_query_audit_150_v1",
    passed:
      rows.length === 150 &&
      metrics.strongRate >= 0.95 &&
      metrics.weakCount === 0 &&
      metrics.failCount === 0 &&
      metrics.missingExpectedTermRows === 0 &&
      metrics.scopeLeakRows === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.queryTimeModelCalls === 0,
    setupArtifacts,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `live-operator-query-audit-150-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `live-operator-query-audit-150-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runLiveOperatorQueryAudit150Cli(): Promise<void> {
  try {
    const { report, output } = await runAndWriteLiveOperatorQueryAudit150();
    process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await closePool();
  }
}
