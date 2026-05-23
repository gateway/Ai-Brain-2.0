import { createHash } from "node:crypto";
import { withClient } from "../db/client.js";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export interface QueryReviewUnknownCandidate {
  readonly namespaceId: string;
  readonly toolName: string;
  readonly queryText: string;
  readonly suggestedRetrievalDomain: string;
  readonly blockedReason: string;
  readonly graduationRecommendation: string;
  readonly routingReasons: readonly string[];
}

export async function persistQueryReviewUnknownCandidate(candidate: QueryReviewUnknownCandidate): Promise<void> {
  const normalizedQuery = normalizeWhitespace(candidate.queryText);
  if (!normalizedQuery) {
    return;
  }
  const queryHash = stableHash(`${candidate.toolName}:${normalizedQuery.toLowerCase()}`);
  const suggestedKey = `unknown_query:${candidate.suggestedRetrievalDomain}:${queryHash}`;
  await withClient(async (client) => {
    await client.query(
      `
        INSERT INTO taxonomy_review_items (
          namespace_id,
          taxonomy_version,
          suggested_key,
          suggested_label,
          proposed_domain,
          proposed_family,
          mapped_domain,
          mapped_family,
          example_evidence,
          reason,
          metadata
        )
        VALUES ($1, 'query_catalog_v1', $2, $3, 'review_unknown', 'review_only', 'review_unknown', 'review_only', $4, $5, $6::jsonb)
        ON CONFLICT (namespace_id, taxonomy_version, suggested_key)
        DO UPDATE SET
          evidence_count = taxonomy_review_items.evidence_count + 1,
          example_evidence = COALESCE(taxonomy_review_items.example_evidence, EXCLUDED.example_evidence),
          reason = COALESCE(taxonomy_review_items.reason, EXCLUDED.reason),
          metadata = taxonomy_review_items.metadata || EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        candidate.namespaceId,
        suggestedKey,
        "Query contract review backlog item",
        normalizedQuery,
        candidate.blockedReason,
        JSON.stringify({
          kind: "query",
          sourceRoute: "n/a",
          taxonomyProfile: "review_only",
          suggestedRetrievalDomain: candidate.suggestedRetrievalDomain,
          blockedReason: candidate.blockedReason,
          queryHash,
          toolName: candidate.toolName,
          occurrenceCount: 1,
          routingReasons: candidate.routingReasons,
          graduationRecommendation: candidate.graduationRecommendation
        })
      ]
    );
  });
}
