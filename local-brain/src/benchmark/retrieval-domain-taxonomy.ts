import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RETRIEVAL_DOMAIN_SPECS,
  primaryRetrievalDomainForQueryContract,
  primaryRetrievalDomainForSourceRoute,
  queryContractNamesForRegistry,
  retrievalDomainsForSourceRoute,
  sourceRoutesForRegistry,
  type RetrievalDomain
} from "../taxonomy/retrieval-domain-registry.js";
import type { TaxonomyProfile } from "../ingest/router-v2.js";

const TAXONOMY_PROFILES: readonly TaxonomyProfile[] = [
  "direct_fact",
  "relation_event",
  "temporal_event",
  "task_ops",
  "profile_report",
  "document_summary",
  "review_only"
];

interface RetrievalDomainTaxonomyReport {
  readonly generatedAt: string;
  readonly benchmark: "retrieval_domain_taxonomy";
  readonly passed: boolean;
  readonly metrics: {
    readonly sourceRouteCoverageRate: number;
    readonly queryContractCoverageRate: number;
    readonly taxonomyProfileCoverageRate: number;
    readonly reviewUnknownPresent: boolean;
    readonly projectDefinitionPresent: boolean;
  };
  readonly sourceRoutes: readonly {
    readonly sourceRoute: string;
    readonly primaryRetrievalDomain: RetrievalDomain;
    readonly retrievalDomainCandidates: readonly RetrievalDomain[];
  }[];
  readonly queryContracts: readonly {
    readonly queryContract: string;
    readonly retrievalDomain: RetrievalDomain;
  }[];
  readonly failures: readonly string[];
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

function markdown(report: RetrievalDomainTaxonomyReport): string {
  return [
    "# Retrieval Domain Taxonomy",
    "",
    `- passed: ${report.passed}`,
    `- sourceRouteCoverageRate: ${report.metrics.sourceRouteCoverageRate}`,
    `- queryContractCoverageRate: ${report.metrics.queryContractCoverageRate}`,
    `- taxonomyProfileCoverageRate: ${report.metrics.taxonomyProfileCoverageRate}`,
    `- failures: ${report.failures.length === 0 ? "none" : report.failures.join(", ")}`
  ].join("\n");
}

export async function runRetrievalDomainTaxonomyBenchmark(): Promise<RetrievalDomainTaxonomyReport> {
  const sourceRoutes = sourceRoutesForRegistry().map((sourceRoute) => ({
    sourceRoute,
    primaryRetrievalDomain: primaryRetrievalDomainForSourceRoute(sourceRoute),
    retrievalDomainCandidates: retrievalDomainsForSourceRoute(sourceRoute)
  }));
  const queryContracts = queryContractNamesForRegistry().map((queryContract) => ({
    queryContract,
    retrievalDomain: primaryRetrievalDomainForQueryContract(queryContract)
  }));
  const taxonomyProfilesCovered = new Set(RETRIEVAL_DOMAIN_SPECS.flatMap((spec) => spec.allowedTaxonomyProfiles));
  const failures: string[] = [];
  if (sourceRoutes.some((row) => row.retrievalDomainCandidates.length === 0)) failures.push("source_route_domain_mapping_missing");
  if (queryContracts.some((row) => row.retrievalDomain === "review_unknown" && row.queryContract !== "abstention" && row.queryContract !== "review_only")) {
    failures.push("query_contract_unexpected_review_unknown");
  }
  for (const profile of TAXONOMY_PROFILES) {
    if (!taxonomyProfilesCovered.has(profile)) failures.push(`taxonomy_profile_unmapped:${profile}`);
  }
  if (!RETRIEVAL_DOMAIN_SPECS.some((spec) => spec.domain === "review_unknown")) failures.push("review_unknown_domain_missing");
  if (!RETRIEVAL_DOMAIN_SPECS.some((spec) => spec.domain === "project_definition")) failures.push("project_definition_domain_missing");
  return {
    generatedAt: new Date().toISOString(),
    benchmark: "retrieval_domain_taxonomy",
    passed: failures.length === 0,
    metrics: {
      sourceRouteCoverageRate: rate(sourceRoutes.filter((row) => row.retrievalDomainCandidates.length > 0).length, sourceRoutes.length),
      queryContractCoverageRate: rate(queryContracts.filter((row) => Boolean(row.retrievalDomain)).length, queryContracts.length),
      taxonomyProfileCoverageRate: rate(TAXONOMY_PROFILES.filter((profile) => taxonomyProfilesCovered.has(profile)).length, TAXONOMY_PROFILES.length),
      reviewUnknownPresent: RETRIEVAL_DOMAIN_SPECS.some((spec) => spec.domain === "review_unknown"),
      projectDefinitionPresent: RETRIEVAL_DOMAIN_SPECS.some((spec) => spec.domain === "project_definition")
    },
    sourceRoutes,
    queryContracts,
    failures
  };
}

export async function runAndWriteRetrievalDomainTaxonomyBenchmark(): Promise<RetrievalDomainTaxonomyReport> {
  const report = await runRetrievalDomainTaxonomyBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  await writeFile(path.join(dir, `retrieval-domain-taxonomy-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(dir, `retrieval-domain-taxonomy-${stamp}.md`), `${markdown(report)}\n`);
  if (!report.passed) {
    throw new Error(`retrieval-domain-taxonomy failed: ${report.failures.join(", ")}`);
  }
  return report;
}

export async function runRetrievalDomainTaxonomyCli(): Promise<void> {
  const report = await runAndWriteRetrievalDomainTaxonomyBenchmark();
  console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2));
}
