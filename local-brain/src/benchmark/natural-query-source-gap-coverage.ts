import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteNaturalQueryReviewBenchmark } from "./natural-query-review.js";

type AuditOwner =
  | "source_absent"
  | "projection_missing"
  | "projection_unusable"
  | "reader_shape"
  | "subject_binding"
  | "current_state_gap"
  | "profile_summary_gap"
  | "conversation_recap_gap"
  | "harness"
  | "source_bound_ok";

interface AuditTarget {
  readonly name: string;
  readonly sourceTerms: readonly string[];
  readonly minimumSourceTermMatches: number;
  readonly projectionVersions: readonly string[];
  readonly projectionTopicKey?: string;
  readonly expectedOwnerWhenProjectionMissing: AuditOwner;
}

interface AuditRow {
  readonly name: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly automatedVerdict: string;
  readonly confidence: string | null;
  readonly evidenceCount: number;
  readonly sourceEvidenceStatus: "source_present" | "source_absent";
  readonly evidenceQuote: string | null;
  readonly sourceSearchTerms: readonly string[];
  readonly projectionHeadCount: number;
  readonly projectionEntryCount: number;
  readonly owner: AuditOwner;
  readonly recommendedAction: string;
}

export interface NaturalQuerySourceGapCoverageReport {
  readonly generatedAt: string;
  readonly benchmark: "natural_query_source_gap_coverage";
  readonly artifactSchemaVersion: "natural_query_source_gap_coverage_v1";
  readonly passed: boolean;
  readonly naturalQueryArtifactPath: string;
  readonly metrics: {
    readonly auditedCount: number;
    readonly unknownOwnerCount: number;
    readonly sourcePresentCount: number;
    readonly sourcePresentWithEvidenceQuoteCount: number;
    readonly projectionMissingCount: number;
    readonly projectionUnusableCount: number;
    readonly sourceAbsentCount: number;
  };
  readonly rows: readonly AuditRow[];
  readonly failures: readonly string[];
}

const TARGETS: readonly AuditTarget[] = [
  {
    name: "coffee_current_state",
    sourceTerms: ["coffee", "pour-over", "espresso"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["alias_current_state_projection_v1"],
    expectedOwnerWhenProjectionMissing: "current_state_gap"
  },
  {
    name: "public_profile_summary",
    sourceTerms: ["Martin Mark", "Columbus", "Susan Thomas", "Wellness retreats"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["source_profile_summary_projection_v1"],
    projectionTopicKey: "martin_mark_profile",
    expectedOwnerWhenProjectionMissing: "profile_summary_gap"
  },
  {
    name: "yesterday_work_recap",
    sourceTerms: ["AI Brain", "Preset Kitchen", "Bumblebee", "Two Way", "Well Inked"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["conversation_recap_projection_v1"],
    projectionTopicKey: "yesterday_work_recap",
    expectedOwnerWhenProjectionMissing: "conversation_recap_gap"
  },
  {
    name: "yesterday_talk_recap",
    sourceTerms: ["AI Brain", "Preset Kitchen", "Bumblebee", "Two Way", "Well Inked"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["conversation_recap_projection_v1"],
    projectionTopicKey: "yesterday_work_recap",
    expectedOwnerWhenProjectionMissing: "conversation_recap_gap"
  },
  {
    name: "omi_conversation_recap",
    sourceTerms: ["ladyboys", "Dan", "Rhonda"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["conversation_recap_projection_v1"],
    projectionTopicKey: "omi_ladyboys_2026_03_22",
    expectedOwnerWhenProjectionMissing: "conversation_recap_gap"
  },
  {
    name: "omi_explain_recap",
    sourceTerms: ["ladyboys", "Dan", "Rhonda"],
    minimumSourceTermMatches: 3,
    projectionVersions: ["conversation_recap_projection_v1"],
    projectionTopicKey: "omi_ladyboys_2026_03_22",
    expectedOwnerWhenProjectionMissing: "conversation_recap_gap"
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function toMarkdown(report: NaturalQuerySourceGapCoverageReport): string {
  const lines = [
    "# Natural Query Source-Gap Coverage",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- naturalQueryArtifactPath: ${report.naturalQueryArtifactPath}`,
    `- auditedCount: ${report.metrics.auditedCount}`,
    `- unknownOwnerCount: ${report.metrics.unknownOwnerCount}`,
    `- sourcePresentWithEvidenceQuote: ${report.metrics.sourcePresentWithEvidenceQuoteCount}/${report.metrics.sourcePresentCount}`,
    "",
    "## Rows",
    ""
  ];
  for (const row of report.rows) {
    lines.push(
      `- ${row.name}: owner=${row.owner}; verdict=${row.automatedVerdict}; source=${row.sourceEvidenceStatus}; projections=${row.projectionHeadCount}/${row.projectionEntryCount}; action=${row.recommendedAction}`
    );
    if (row.evidenceQuote) {
      lines.push(`  - quote: ${row.evidenceQuote}`);
    }
  }
  if (report.failures.length > 0) {
    lines.push("", "## Failures", "", ...report.failures.map((failure) => `- ${failure}`));
  }
  return `${lines.join("\n")}\n`;
}

async function sourceQuote(namespaceId: string, terms: readonly string[], minimumMatches: number): Promise<string | null> {
  const rows = await queryRows<{ readonly text_content: string }>(
    `
      SELECT ac.text_content
      FROM artifacts a
      JOIN artifact_chunks ac ON ac.artifact_id = a.id
      WHERE a.namespace_id = $1
        AND (${terms.map((_, index) => `lower(ac.text_content) LIKE $${index + 2}`).join(" OR ")})
      ORDER BY a.uri DESC, ac.chunk_index ASC
      LIMIT 10
    `,
    [namespaceId, ...terms.map((term) => `%${term.toLowerCase()}%`)]
  );
  const scoredRows = rows
    .map((row) => ({
      row,
      score: terms.filter((term) => row.text_content.toLowerCase().includes(term.toLowerCase())).length
    }))
    .sort((left, right) => right.score - left.score);
  const best = scoredRows[0] ?? null;
  const row = best && best.score >= minimumMatches ? best.row : null;
  return row?.text_content?.replace(/\s+/gu, " ").trim().slice(0, 360) ?? null;
}

async function projectionCounts(namespaceId: string, target: AuditTarget): Promise<{ readonly heads: number; readonly entries: number; readonly quote: string | null }> {
  const rows = await queryRows<{ readonly head_count: string; readonly entry_count: string; readonly quote: string | null }>(
    `
      WITH heads AS (
        SELECT id
        FROM contract_projection_heads
        WHERE namespace_id = $1
          AND projection_version = ANY($2::text[])
          AND ($3::text IS NULL OR metadata->>'topic_key' = $3 OR bundle_key LIKE '%' || $3)
          AND truth_status = 'active'
      )
      SELECT
        (SELECT count(*) FROM heads)::text AS head_count,
        (SELECT count(*) FROM contract_projection_entries entry JOIN heads ON heads.id = entry.projection_head_id WHERE entry.truth_status = 'active')::text AS entry_count,
        (SELECT entry.metadata->>'source_quote' FROM contract_projection_entries entry JOIN heads ON heads.id = entry.projection_head_id WHERE entry.truth_status = 'active' AND NULLIF(entry.metadata->>'source_quote', '') IS NOT NULL LIMIT 1) AS quote
    `,
    [namespaceId, target.projectionVersions, target.projectionTopicKey ?? null]
  );
  return {
    heads: Number(rows[0]?.head_count ?? 0),
    entries: Number(rows[0]?.entry_count ?? 0),
    quote: rows[0]?.quote ?? null
  };
}

function classify(params: {
  readonly verdict: string;
  readonly sourcePresent: boolean;
  readonly projectionEntryCount: number;
  readonly target: AuditTarget;
}): { readonly owner: AuditOwner; readonly action: string } {
  if (!params.sourcePresent) {
    return { owner: "source_absent", action: "document_source_search_proof_or_reseed_fixture" };
  }
  if (params.projectionEntryCount === 0) {
    return { owner: params.target.expectedOwnerWhenProjectionMissing, action: "build_or_fix_source_bound_projection_admission" };
  }
  if (params.verdict === "pass") {
    return { owner: "source_bound_ok", action: "none" };
  }
  return { owner: "projection_unusable", action: "inspect_projection_selection_and_reader_shape" };
}

export async function runAndWriteNaturalQuerySourceGapCoverage(): Promise<{
  readonly report: NaturalQuerySourceGapCoverageReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION ??= "1";
  process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION ??= "1";
  const naturalQuery = await runAndWriteNaturalQueryReviewBenchmark();
  const targetNames = new Set(TARGETS.map((target) => target.name));
  const scenarios = naturalQuery.report.scenarios.filter((scenario) => targetNames.has(scenario.name));
  const namespaces = [...new Set(scenarios.map((scenario) => scenario.namespaceId))];
  for (const namespaceId of namespaces) {
    await rebuildContractProjectionsNamespace(namespaceId);
  }

  const rows: AuditRow[] = [];
  for (const scenario of scenarios) {
    const target = TARGETS.find((item) => item.name === scenario.name);
    if (!target) continue;
    const counts = await projectionCounts(scenario.namespaceId, target);
    const quote = (await sourceQuote(scenario.namespaceId, target.sourceTerms, target.minimumSourceTermMatches)) ?? counts.quote;
    const classified = classify({
      verdict: scenario.automatedVerdict,
      sourcePresent: Boolean(quote),
      projectionEntryCount: counts.entries,
      target
    });
    rows.push({
      name: scenario.name,
      namespaceId: scenario.namespaceId,
      query: scenario.query,
      automatedVerdict: scenario.automatedVerdict,
      confidence: scenario.confidence,
      evidenceCount: scenario.evidence.length,
      sourceEvidenceStatus: quote ? "source_present" : "source_absent",
      evidenceQuote: quote,
      sourceSearchTerms: target.sourceTerms,
      projectionHeadCount: counts.heads,
      projectionEntryCount: counts.entries,
      owner: classified.owner,
      recommendedAction: classified.action
    });
  }
  for (const target of TARGETS.filter((item) => !rows.some((row) => row.name === item.name))) {
    const query =
      target.name === "yesterday_talk_recap"
        ? "What did I talk about yesterday?"
        : target.name === "yesterday_work_recap"
          ? "What did I do yesterday?"
          : null;
    if (!query) continue;
    await rebuildContractProjectionsNamespace("personal");
    const payload = ((await executeMcpTool("memory.search", { namespace_id: "personal", query, limit: 8 })) as { readonly structuredContent?: any })
      .structuredContent;
    const counts = await projectionCounts("personal", target);
    const quote = (await sourceQuote("personal", target.sourceTerms, target.minimumSourceTermMatches)) ?? counts.quote;
    const confidence = typeof payload?.duality?.confidence === "string" ? payload.duality.confidence : null;
    const evidenceCount = Array.isArray(payload?.duality?.evidence) ? payload.duality.evidence.length : 0;
    const claimText = typeof payload?.duality?.claim?.text === "string" ? payload.duality.claim.text : "";
    const verdict =
      confidence === "confident" &&
      target.sourceTerms.slice(0, 3).some((term) => claimText.toLowerCase().includes(term.toLowerCase())) &&
      evidenceCount > 0
        ? "pass"
        : "fail";
    const classified = classify({
      verdict,
      sourcePresent: Boolean(quote),
      projectionEntryCount: counts.entries,
      target
    });
    rows.push({
      name: target.name,
      namespaceId: "personal",
      query,
      automatedVerdict: verdict,
      confidence,
      evidenceCount,
      sourceEvidenceStatus: quote ? "source_present" : "source_absent",
      evidenceQuote: quote,
      sourceSearchTerms: target.sourceTerms,
      projectionHeadCount: counts.heads,
      projectionEntryCount: counts.entries,
      owner: classified.owner,
      recommendedAction: classified.action
    });
  }

  const failures: string[] = [];
  if (rows.length !== TARGETS.length) failures.push(`audited ${rows.length}/${TARGETS.length} target rows`);
  if (rows.some((row) => row.sourceEvidenceStatus === "source_present" && !row.evidenceQuote)) failures.push("source-present row missing evidence quote");
  const report: NaturalQuerySourceGapCoverageReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "natural_query_source_gap_coverage",
    artifactSchemaVersion: "natural_query_source_gap_coverage_v1",
    passed: failures.length === 0,
    naturalQueryArtifactPath: naturalQuery.output.jsonPath,
    metrics: {
      auditedCount: rows.length,
      unknownOwnerCount: 0,
      sourcePresentCount: rows.filter((row) => row.sourceEvidenceStatus === "source_present").length,
      sourcePresentWithEvidenceQuoteCount: rows.filter((row) => row.sourceEvidenceStatus === "source_present" && row.evidenceQuote).length,
      projectionMissingCount: rows.filter((row) => ["current_state_gap", "profile_summary_gap", "conversation_recap_gap"].includes(row.owner)).length,
      projectionUnusableCount: rows.filter((row) => row.owner === "projection_unusable").length,
      sourceAbsentCount: rows.filter((row) => row.owner === "source_absent").length
    },
    rows,
    failures
  };
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `natural-query-source-gap-coverage-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `natural-query-source-gap-coverage-${stamp}.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runNaturalQuerySourceGapCoverageCli(): Promise<void> {
  const { report, output } = await runAndWriteNaturalQuerySourceGapCoverage();
  process.stdout.write(JSON.stringify({ passed: report.passed, metrics: report.metrics, jsonPath: output.jsonPath, markdownPath: output.markdownPath }, null, 2));
  process.stdout.write("\n");
  await closePool();
}
