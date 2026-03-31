import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import type { ProductionFailureCategory } from "./production-confidence-shared.js";
import { countFailureCategories } from "./production-confidence-shared.js";

interface ReviewResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly failureCategories: readonly ProductionFailureCategory[];
}

export interface CanonicalIdentityReviewReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly results: readonly ReviewResult[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
    readonly failureCategoryCounts: Record<ProductionFailureCategory, number>;
  };
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.relationships)) {
    return payload.relationships;
  }
  if (Array.isArray(payload?.graph?.edges)) {
    return payload.graph.edges;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  return [];
}

function toMarkdown(report: CanonicalIdentityReviewReport): string {
  const lines = [
    "# Canonical Identity Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- pass/fail: ${report.summary.pass}/${report.summary.fail}`,
    `- failureCategoryCounts: ${JSON.stringify(report.summary.failureCategoryCounts)}`,
    "",
    "## Results",
    ""
  ];

  for (const result of report.results) {
    lines.push(`- ${result.name}: ${result.passed ? "pass" : "fail"}`);
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function reviewAliasCollapse(namespaceId: string): Promise<ReviewResult> {
  const wrapped = (await executeMcpTool("memory.get_graph", {
    namespace_id: namespaceId,
    entity_name: "Kozimui",
    limit: 40
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const graph = payload?.graph ?? payload;
  const nodeNames = Array.isArray(graph?.nodes) ? graph.nodes.map((node: any) => String(node?.name ?? "")) : [];
  const failures: string[] = [];

  if (!hasTerm(payload, "koh samui")) {
    failures.push("canonical Koh Samui missing from alias graph");
  }
  if (nodeNames.some((name: string) => name.toLowerCase() === "kozimui")) {
    failures.push("alias node Kozimui survived as a split atlas node");
  }

  return {
    name: "alias_collapse_koh_samui",
    passed: failures.length === 0,
    failures,
    failureCategories: failures.length === 0 ? [] : ["entity_resolution_error", "atlas_truth_error"]
  };
}

async function reviewSelfAliasResolution(namespaceId: string): Promise<ReviewResult> {
  const wrapped = (await executeMcpTool("memory.get_graph", {
    namespace_id: namespaceId,
    entity_name: "Steve",
    limit: 40
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const graph = payload?.graph ?? payload;
  const nodeCount = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
  const edgeCount = Array.isArray(graph?.edges) ? graph.edges.length : 0;
  const failures: string[] = [];

  if (!hasTerm(payload, "steve tietze")) {
    failures.push("Steve alias did not resolve to canonical self entity Steve Tietze");
  }
  if (!hasTerm(payload, "\"requestedentity\":\"steve\"")) {
    failures.push("Steve graph payload did not preserve the requested alias");
  }
  if (nodeCount < 3) {
    failures.push(`Steve focus graph returned too few nodes (${nodeCount})`);
  }
  if (edgeCount < 2) {
    failures.push(`Steve focus graph returned too few edges (${edgeCount})`);
  }

  return {
    name: "self_alias_steve",
    passed: failures.length === 0,
    failures,
    failureCategories: failures.length === 0 ? [] : ["entity_resolution_error", "atlas_truth_error"]
  };
}

async function reviewClarificationClosure(namespaceId: string): Promise<ReviewResult> {
  const wrapped = (await executeMcpTool("memory.get_clarifications", {
    namespace_id: namespaceId,
    query: "uncle",
    limit: 8
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const failures: string[] = [];

  if (items.length > 0) {
    failures.push(`expected no unresolved uncle clarification items, found ${items.length}`);
  }
  if (!hasTerm(payload, "no open clarification items matched")) {
    failures.push("closure guidance did not report a clean inbox state");
  }

  return {
    name: "clarification_closure_uncle",
    passed: failures.length === 0,
    failures,
    failureCategories: failures.length === 0 ? [] : ["clarification_closure_error"]
  };
}

async function reviewRelationshipHistory(namespaceId: string): Promise<ReviewResult> {
  const wrapped = (await executeMcpTool("memory.get_relationships", {
    namespace_id: namespaceId,
    entity_name: "Lauren",
    include_historical: true,
    limit: 12
  })) as { readonly structuredContent?: unknown };
  const payload = wrapped.structuredContent as any;
  const failures: string[] = [];

  if (!hasTerm(payload, "former_partner_of")) {
    failures.push("historical former_partner_of edge missing for Lauren");
  }
  if (!hasTerm(payload, "validuntil")) {
    failures.push("historical relationship payload missing validUntil");
  }
  if (evidenceItems(payload).length === 0) {
    failures.push("no relationship evidence returned for Lauren history");
  }

  return {
    name: "relationship_history_lauren",
    passed: failures.length === 0,
    failures,
    failureCategories: failures.length === 0 ? [] : ["temporal_resolution_error", "weak_provenance"]
  };
}

async function reviewCanonicalAudits(namespaceId: string): Promise<ReviewResult> {
  const [redirectRows, relationshipRows] = await Promise.all([
    queryRows<{ readonly total: string }>(
      `
        SELECT COUNT(*)::text AS total
        FROM canonical_redirect_integrity_audit
        WHERE namespace_id = $1
          AND redirect_status <> 'ok'
      `,
      [namespaceId]
    ),
    queryRows<{ readonly total: string }>(
      `
        SELECT COUNT(*)::text AS total
        FROM relationship_canonical_integrity_audit
        WHERE namespace_id = $1
      `,
      [namespaceId]
    )
  ]);
  const redirectCount = Number(redirectRows[0]?.total ?? "0");
  const relationshipCount = Number(relationshipRows[0]?.total ?? "0");
  const failures: string[] = [];

  if (redirectCount > 0) {
    failures.push(`redirect integrity audit found ${redirectCount} bad canonical redirects`);
  }
  if (relationshipCount > 0) {
    failures.push(`relationship canonical integrity audit found ${relationshipCount} stale merged-entity rows`);
  }

  return {
    name: "canonical_integrity_audits",
    passed: failures.length === 0,
    failures,
    failureCategories: failures.length === 0 ? [] : ["atlas_truth_error"]
  };
}

export async function runCanonicalIdentityReview(namespaceId = "personal"): Promise<CanonicalIdentityReviewReport> {
  const results = await Promise.all([
    reviewAliasCollapse(namespaceId),
    reviewSelfAliasResolution(namespaceId),
    reviewClarificationClosure(namespaceId),
    reviewRelationshipHistory(namespaceId),
    reviewCanonicalAudits(namespaceId)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    namespaceId,
    results,
    summary: {
      pass: results.filter((result) => result.passed).length,
      fail: results.filter((result) => !result.passed).length,
      failureCategoryCounts: countFailureCategories(results)
    }
  };
}

export async function runAndWriteCanonicalIdentityReview(namespaceId = "personal"): Promise<{
  readonly report: CanonicalIdentityReviewReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const report = await runCanonicalIdentityReview(namespaceId);
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(dir, `canonical-identity-review-${stamp}.json`);
  const markdownPath = path.join(dir, `canonical-identity-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runCanonicalIdentityReviewCli(): Promise<void> {
  try {
    const namespaceId = process.argv[2] || "personal";
    const result = await runAndWriteCanonicalIdentityReview(namespaceId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
