import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { closePool, queryRows, withClient } from "../db/client.js";

interface TaxonomyReviewBacklogReport {
  readonly generatedAt: string;
  readonly benchmark: "taxonomy_review_backlog";
  readonly namespaceId: string;
  readonly passed: boolean;
  readonly metrics: {
    readonly openItemCount: number;
    readonly reviewMetadataCoverageRate: number;
    readonly repeatedClusterRecommendationCount: number;
    readonly missingRecommendationCount: number;
    readonly missingReviewMetadataCount: number;
  };
  readonly rows: readonly {
    readonly suggestedKey: string;
    readonly evidenceCount: number;
    readonly kind: string | null;
    readonly suggestedRetrievalDomain: string | null;
    readonly blockedReason: string | null;
    readonly graduationRecommendation: string | null;
  }[];
  readonly failures: readonly string[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function seedBacklog(namespaceId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("DELETE FROM taxonomy_review_items WHERE namespace_id = $1", [namespaceId]);
    const examples = [
      {
        key: "unknown_source:meeting_notes",
        label: "Possible meeting notes",
        domain: "project_current_state",
        family: "review_only",
        evidenceCount: 10,
        evidence: "Meeting notes: Alice owns the cache task; Bob is blocked on the migration.",
        reason: "Repeated other/generic sources look like meeting notes.",
        metadata: {
          kind: "source",
          sourceRoute: "generic_text",
          sourceIntelligenceProfile: "generic_text",
          taxonomyProfile: "review_only",
          suggestedSourceProfile: "meeting_notes",
          suggestedRetrievalDomain: "project_current_state",
          blockedReason: "review_only_taxonomy_profile",
          sourceHash: stableHash("meeting-notes"),
          occurrenceCount: 10,
          graduationRecommendation: "define_new_source_profile"
        }
      },
      {
        key: "unknown_query:project_definition",
        label: "Possible project definition query",
        domain: "project_definition",
        family: "review_only",
        evidenceCount: 3,
        evidence: "What is Two Way?",
        reason: "Standalone project definition questions should not route as relationship map.",
        metadata: {
          kind: "query",
          sourceRoute: "n/a",
          sourceIntelligenceProfile: "n/a",
          taxonomyProfile: "review_only",
          suggestedSourceProfile: null,
          suggestedRetrievalDomain: "project_definition",
          blockedReason: "query_contract_missing",
          queryHash: stableHash("What is Two Way?"),
          occurrenceCount: 3,
          graduationRecommendation: "define_new_query_contract"
        }
      }
    ];
    for (const item of examples) {
      await client.query(
        `
          INSERT INTO taxonomy_review_items (
            namespace_id, taxonomy_version, suggested_key, suggested_label, proposed_domain, proposed_family,
            mapped_domain, mapped_family, evidence_count, distinct_source_count, example_evidence, reason, metadata
          )
          VALUES ($1, 'retrieval_domain_taxonomy_v1', $2, $3, $4, $5, $4, $5, $6, 1, $7, $8, $9::jsonb)
        `,
        [namespaceId, item.key, item.label, item.domain, item.family, item.evidenceCount, item.evidence, item.reason, JSON.stringify(item.metadata)]
      );
    }
  });
}

export async function runTaxonomyReviewBacklogBenchmark(
  namespaceId = "benchmark_taxonomy_review_backlog"
): Promise<TaxonomyReviewBacklogReport> {
  await seedBacklog(namespaceId);
  const rows = await queryRows<{
    readonly suggested_key: string;
    readonly evidence_count: string;
    readonly kind: string | null;
    readonly suggested_retrieval_domain: string | null;
    readonly blocked_reason: string | null;
    readonly graduation_recommendation: string | null;
  }>(
    `
      SELECT
        suggested_key,
        evidence_count::text,
        metadata->>'kind' AS kind,
        metadata->>'suggestedRetrievalDomain' AS suggested_retrieval_domain,
        metadata->>'blockedReason' AS blocked_reason,
        metadata->>'graduationRecommendation' AS graduation_recommendation
      FROM taxonomy_review_items
      WHERE namespace_id = $1
        AND status = 'open'
      ORDER BY evidence_count DESC, updated_at DESC
    `,
    [namespaceId]
  );
  const mapped = rows.map((row) => ({
    suggestedKey: row.suggested_key,
    evidenceCount: Number(row.evidence_count),
    kind: row.kind,
    suggestedRetrievalDomain: row.suggested_retrieval_domain,
    blockedReason: row.blocked_reason,
    graduationRecommendation: row.graduation_recommendation
  }));
  const missingReviewMetadata = mapped.filter((row) => !row.kind || !row.suggestedRetrievalDomain || !row.blockedReason);
  const repeatedWithoutRecommendation = mapped.filter((row) => row.evidenceCount >= 10 && !row.graduationRecommendation);
  const failures: string[] = [];
  if (mapped.length === 0) failures.push("taxonomy_review_items_missing");
  if (missingReviewMetadata.length > 0) failures.push("review_metadata_missing");
  if (repeatedWithoutRecommendation.length > 0) failures.push("repeated_cluster_recommendation_missing");
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "taxonomy_review_backlog",
    namespaceId,
    passed: failures.length === 0,
    metrics: {
      openItemCount: mapped.length,
      reviewMetadataCoverageRate: rate(mapped.length - missingReviewMetadata.length, mapped.length),
      repeatedClusterRecommendationCount: mapped.filter((row) => row.evidenceCount >= 10 && Boolean(row.graduationRecommendation)).length,
      missingRecommendationCount: repeatedWithoutRecommendation.length,
      missingReviewMetadataCount: missingReviewMetadata.length
    },
    rows: mapped,
    failures
  };
}

function markdown(report: TaxonomyReviewBacklogReport): string {
  return [
    "# Taxonomy Review Backlog",
    "",
    `- passed: ${report.passed}`,
    `- openItemCount: ${report.metrics.openItemCount}`,
    `- reviewMetadataCoverageRate: ${report.metrics.reviewMetadataCoverageRate}`,
    `- repeatedClusterRecommendationCount: ${report.metrics.repeatedClusterRecommendationCount}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runAndWriteTaxonomyReviewBacklogBenchmark(): Promise<TaxonomyReviewBacklogReport> {
  const report = await runTaxonomyReviewBacklogBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `taxonomy-review-backlog-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `taxonomy-review-backlog-${stamp}.md`), `${markdown(report)}\n`);
  await closePool();
  if (!report.passed) {
    throw new Error(`taxonomy-review-backlog failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runTaxonomyReviewBacklogCli(): Promise<void> {
  const report = await runAndWriteTaxonomyReviewBacklogBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
