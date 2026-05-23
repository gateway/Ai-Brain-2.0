import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryRows } from "../db/client.js";
import { buildGraphAliasLedger, type GraphAliasCandidate } from "../retrieval/graph-alias-ledger.js";
import { manualGraphAliasInventory } from "../retrieval/place-aliases.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface EntityRoleConflictRow {
  readonly canonical_name: string;
  readonly roles: readonly string[];
}

export interface GraphAliasProductizationReport {
  readonly generatedAt: string;
  readonly benchmark: "graph_alias_productization_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly passed: boolean;
  readonly manualInventoryCount: number;
  readonly aliasCandidateCount: number;
  readonly promotionLedgerPath: string;
  readonly metrics: {
    readonly aliasPromotionPrecision: number;
    readonly aliasPromotionRecall: number;
    readonly aliasProvenanceCoverageRate: number;
    readonly authoritativeAutoPromotionCount: number;
    readonly wrongSubjectBindingCount: number;
    readonly wrongPlaceBindingCount: number;
    readonly roleConflictCount: number;
  };
  readonly requiredAliases: readonly string[];
  readonly foundAliases: readonly string[];
  readonly missingAliases: readonly string[];
  readonly roleConflicts: readonly EntityRoleConflictRow[];
  readonly candidates: readonly GraphAliasCandidate[];
}

const REQUIRED_ALIASES = [
  "Gumi",
  "Gummi",
  "Gumee",
  "Omi Gummi",
  "Ben",
  "Tim",
  "Dan",
  "Chiang Mai",
  "Canass Hotel",
  "Living a Dream",
  "Two Way",
  "Two-Way",
  "2Way"
];

const FALSE_PROMOTION_ALIASES = ["Jeep", "Burning Man", "Washington", "Reno storage", "Istanbul conference"];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function hasCandidate(candidates: readonly GraphAliasCandidate[], alias: string): boolean {
  const key = normalize(alias);
  return candidates.some((candidate) => normalize(candidate.alias) === key && candidate.evidenceCount > 0);
}

function provenanceCovered(candidate: GraphAliasCandidate): boolean {
  return candidate.promotionStatus === "manual_seed" || candidate.sourceUris.length > 0 || candidate.sourceQuotes.length > 0 || candidate.firstSeenAt !== null;
}

async function loadRoleConflicts(): Promise<readonly EntityRoleConflictRow[]> {
  return queryRows<EntityRoleConflictRow>(
    `
      SELECT canonical_name, array_agg(DISTINCT entity_type ORDER BY entity_type) AS roles
      FROM entities
      WHERE namespace_id = 'personal'
        AND lower(canonical_name) IN ('chiang mai', 'gumi', 'gummi', 'omi gummi', 'two way')
      GROUP BY canonical_name
      HAVING count(DISTINCT entity_type) > 1
      ORDER BY canonical_name
    `
  );
}

function metricPrecision(candidates: readonly GraphAliasCandidate[]): number {
  const promotable = candidates.filter((candidate) => candidate.promotionStatus === "benchmarked_promotable");
  if (promotable.length === 0) {
    return 1;
  }
  const falsePromotions = promotable.filter((candidate) => FALSE_PROMOTION_ALIASES.some((alias) => normalize(alias) === normalize(candidate.alias)));
  return (promotable.length - falsePromotions.length) / promotable.length;
}

function toMarkdown(report: GraphAliasProductizationReport): string {
  const lines = [
    "# Graph Alias Productization Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- manualInventoryCount: ${report.manualInventoryCount}`,
    `- aliasCandidateCount: ${report.aliasCandidateCount}`,
    `- aliasPromotionPrecision: ${report.metrics.aliasPromotionPrecision}`,
    `- aliasPromotionRecall: ${report.metrics.aliasPromotionRecall}`,
    `- aliasProvenanceCoverageRate: ${report.metrics.aliasProvenanceCoverageRate}`,
    `- authoritativeAutoPromotionCount: ${report.metrics.authoritativeAutoPromotionCount}`,
    `- wrongSubjectBindingCount: ${report.metrics.wrongSubjectBindingCount}`,
    `- wrongPlaceBindingCount: ${report.metrics.wrongPlaceBindingCount}`,
    `- roleConflictCount: ${report.metrics.roleConflictCount}`,
    "",
    "## Missing Aliases",
    "",
    report.missingAliases.length > 0 ? report.missingAliases.map((alias) => `- ${alias}`).join("\n") : "- none",
    "",
    "## Role Conflicts",
    "",
    report.roleConflicts.length > 0
      ? report.roleConflicts.map((row) => `- ${row.canonical_name}: ${row.roles.join(", ")}`).join("\n")
      : "- none",
    "",
    "## Promotion Ledger",
    "",
    `- ${report.promotionLedgerPath}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteGraphAliasProductizationPack(): Promise<{
  readonly report: GraphAliasProductizationReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string; readonly promotionLedgerPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const candidates = await buildGraphAliasLedger("personal");
  const roleConflicts = await loadRoleConflicts();
  const foundAliases = REQUIRED_ALIASES.filter((alias) => hasCandidate(candidates, alias));
  const missingAliases = REQUIRED_ALIASES.filter((alias) => !foundAliases.includes(alias));
  const aliasPromotionRecall = foundAliases.length / REQUIRED_ALIASES.length;
  const aliasPromotionPrecision = metricPrecision(candidates);
  const aliasProvenanceCoverageRate =
    candidates.length === 0 ? 0 : candidates.filter((candidate) => provenanceCovered(candidate)).length / candidates.length;
  const authoritativeAutoPromotionCount = candidates.filter((candidate) => candidate.authoritative && candidate.promotionStatus !== "manual_seed").length;
  const wrongPlaceBindingCount = candidates.filter((candidate) => candidate.entityRole === "person" && normalize(candidate.alias) === "chiang mai").length;
  const wrongSubjectBindingCount = candidates.filter((candidate) => candidate.entityRole !== "person" && ["dan", "tim", "ben", "gummi", "gumi"].includes(normalize(candidate.alias))).length;
  const metrics = {
    aliasPromotionPrecision,
    aliasPromotionRecall,
    aliasProvenanceCoverageRate,
    authoritativeAutoPromotionCount,
    wrongSubjectBindingCount,
    wrongPlaceBindingCount,
    roleConflictCount: roleConflicts.length
  };
  const outputRoot = outputDir();
  await mkdir(outputRoot, { recursive: true });
  const promotionLedgerPath = path.join(outputRoot, `graph-alias-promotion-ledger-${stamp}.json`);
  const report: GraphAliasProductizationReport = {
    generatedAt,
    benchmark: "graph_alias_productization_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        namespaceId: "personal",
        requiredAliasCount: REQUIRED_ALIASES.length
      }
    }),
    passed:
      metrics.aliasPromotionPrecision >= 0.95 &&
      metrics.aliasPromotionRecall >= 0.9 &&
      metrics.aliasProvenanceCoverageRate >= 0.95 &&
      metrics.authoritativeAutoPromotionCount === 0 &&
      metrics.wrongSubjectBindingCount === 0 &&
      metrics.wrongPlaceBindingCount === 0,
    manualInventoryCount: manualGraphAliasInventory().length,
    aliasCandidateCount: candidates.length,
    promotionLedgerPath,
    metrics,
    requiredAliases: REQUIRED_ALIASES,
    foundAliases,
    missingAliases,
    roleConflicts,
    candidates
  };
  const jsonPath = path.join(outputRoot, `graph-alias-productization-pack-${stamp}.json`);
  const markdownPath = path.join(outputRoot, `graph-alias-productization-pack-${stamp}.md`);
  await writeFile(promotionLedgerPath, `${JSON.stringify({ generatedAt, namespaceId: "personal", candidates }, null, 2)}\n`, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath, promotionLedgerPath } };
}

export async function runGraphAliasProductizationPackCli(): Promise<void> {
  const { report, output } = await runAndWriteGraphAliasProductizationPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${output.promotionLedgerPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
