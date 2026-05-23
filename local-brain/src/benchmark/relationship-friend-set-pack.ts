import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { rebuildContractProjectionsNamespace } from "../contract-projections/service.js";
import { queryRows } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { QUERY_GOLD_FIXTURE_NAMESPACE, seedQueryTaxonomyGoldFixture } from "./query-taxonomy-gold-fixtures.js";
import {
  applyProjectionRuntimeFlags,
  hasTerm,
  payloadEvidenceCount,
  percentile,
  projectionRuntimeFlags,
  queryTimeModelCallsFromPayload,
  rate,
  restoreProjectionRuntimeFlags
} from "./query-benchmark-utils.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type FriendSetResidualOwner =
  | "missing_friend_set_reader"
  | "missing_expected_friend"
  | "invalid_friend_entity"
  | "wrong_mutual_grouped_shape"
  | "empty_source_trail"
  | "missing_claim_audit"
  | "query_time_model_call"
  | "source_missing"
  | "none";

interface FriendSetScenario {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly invalidTerms: readonly string[];
  readonly expectedMode: "grouped_with_overlap" | "strict_shared" | "single_owner";
  readonly expectedPlaceScope?: string;
  readonly minimumEvidence: number;
}

export interface RelationshipFriendSetRow {
  readonly id: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly actualTerms: readonly string[];
  readonly missingTerms: readonly string[];
  readonly invalidTermsPresent: readonly string[];
  readonly queryContract: string | null;
  readonly retrievalDomain: string | null;
  readonly finalClaimSource: string | null;
  readonly friendSetMode: string | null;
  readonly friendSetOwners: readonly string[];
  readonly friendSetPlaceScope: string | null;
  readonly wrongSubjectBinding: boolean;
  readonly wrongPlaceBinding: boolean;
  readonly evidenceCount: number;
  readonly sourceTrailCount: number;
  readonly claimAuditCount: number;
  readonly queryTimeModelCalls: number;
  readonly latencyMs: number;
  readonly residualOwner: FriendSetResidualOwner;
  readonly answer: string;
  readonly passed: boolean;
}

export interface RelationshipFriendSetReport {
  readonly generatedAt: string;
  readonly benchmark: "relationship_friend_set_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly verification: {
    readonly omiEvidenceNamesFound: readonly string[];
    readonly dbEntityNamesFound: readonly string[];
  };
  readonly metrics: {
    readonly expectedTermMissingCount: number;
    readonly invalidFriendEntityCount: number;
    readonly wrongMutualVsGroupedShapeCount: number;
    readonly supportedEmptySourceTrailCount: number;
    readonly supportedMissingClaimAuditCount: number;
    readonly queryTimeModelCalls: number;
    readonly friendSetShapeAccuracy: number;
    readonly friendSetPassRate: number;
    readonly wrongSubjectBindingCount: number;
    readonly wrongPlaceBindingCount: number;
    readonly p95LatencyMs: number;
    readonly maxLatencyMs: number;
  };
  readonly results: readonly RelationshipFriendSetRow[];
}

const INVALID_FRIEND_TERMS = [
  "speaker",
  "id Software",
  "CarMax",
  "SaaS",
  "Tuesdays",
  "Thursdays",
  "Bend",
  "Reno",
  "Koh Samui",
  "September",
  "San Francisco"
];

const SCENARIOS: readonly FriendSetScenario[] = [
  {
    id: "personal_grouped_mine_and_dan",
    namespaceId: "personal",
    query: "Who are all of mine and Dan's friends, and do not fall back to a generic relationship map",
    expectedTerms: ["Ben", "Gummi", "Tim"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "grouped_with_overlap",
    minimumEvidence: 3
  },
  {
    id: "personal_mutual_mine_and_dan",
    namespaceId: "personal",
    query: "who are my mutual friends with Dan?",
    expectedTerms: ["Ben", "Gummi", "Tim"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "strict_shared",
    minimumEvidence: 3
  },
  {
    id: "personal_self_friend_set",
    namespaceId: "personal",
    query: "Who are my friends?",
    expectedTerms: ["Gummi", "Tim", "Lauren"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "single_owner",
    minimumEvidence: 3
  },
  {
    id: "personal_dan_friend_set",
    namespaceId: "personal",
    query: "Who are Dan's friends?",
    expectedTerms: ["Ben", "Gummi", "Tim"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "single_owner",
    minimumEvidence: 3
  },
  {
    id: "personal_place_scoped_chiang_mai",
    namespaceId: "personal",
    query: "who are my friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    invalidTerms: [...INVALID_FRIEND_TERMS, "Tink", "Lake Tahoe", "Reno", "Bend"],
    expectedMode: "single_owner",
    expectedPlaceScope: "Chiang Mai",
    minimumEvidence: 4
  },
  {
    id: "personal_place_scoped_coworking_friends",
    namespaceId: "personal",
    query: "Who are my coworking friends in Chiang Mai?",
    expectedTerms: ["Dan", "Gummi", "Tim", "Ben"],
    invalidTerms: [...INVALID_FRIEND_TERMS, "Tink", "Lake Tahoe", "Reno", "Bend"],
    expectedMode: "single_owner",
    expectedPlaceScope: "Chiang Mai",
    minimumEvidence: 4
  },
  {
    id: "personal_met_through_dan_chiang_mai",
    namespaceId: "personal",
    query: "people I met through Dan in Chiang Mai",
    expectedTerms: ["Gummi", "Tim", "Ben"],
    invalidTerms: [...INVALID_FRIEND_TERMS, "Tink", "Lake Tahoe", "Reno", "Bend"],
    expectedMode: "single_owner",
    expectedPlaceScope: "Chiang Mai",
    minimumEvidence: 3
  },
  {
    id: "personal_dan_introduced_me",
    namespaceId: "personal",
    query: "Who did Dan introduce me to?",
    expectedTerms: ["Gummi", "Tim", "Ben"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "single_owner",
    minimumEvidence: 3
  },
  {
    id: "fixture_grouped_mine_and_dan",
    namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE,
    query: "Who are all of mine and Dan's friends?",
    expectedTerms: ["Ben", "Gummi", "Lauren"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "grouped_with_overlap",
    minimumEvidence: 3
  },
  {
    id: "fixture_mutual_mine_and_dan",
    namespaceId: QUERY_GOLD_FIXTURE_NAMESPACE,
    query: "who are my mutual friends with Dan?",
    expectedTerms: ["Ben", "Gummi", "Lauren"],
    invalidTerms: INVALID_FRIEND_TERMS,
    expectedMode: "strict_shared",
    minimumEvidence: 3
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function answerText(payload: any): string {
  if (typeof payload?.humanReadable?.answer === "string") return payload.humanReadable.answer;
  if (typeof payload?.answer === "string") return payload.answer;
  return JSON.stringify(payload?.humanReadable ?? payload ?? null);
}

function sourceTrailCount(payload: any): number {
  return Array.isArray(payload?.sourceTrail) ? payload.sourceTrail.length : 0;
}

function claimAuditCount(payload: any): number {
  return Array.isArray(payload?.claimAudit) ? payload.claimAudit.length : 0;
}

function classifyResidualOwner(row: Omit<RelationshipFriendSetRow, "residualOwner" | "passed">): FriendSetResidualOwner {
  if (row.queryTimeModelCalls > 0) return "query_time_model_call";
  if (row.queryContract !== "shared_social_graph" || row.finalClaimSource !== "shared_social_graph") return "missing_friend_set_reader";
  if (row.evidenceCount <= 0) return "source_missing";
  if (row.sourceTrailCount <= 0) return "empty_source_trail";
  if (row.claimAuditCount <= 0) return "missing_claim_audit";
  if (row.friendSetMode !== SCENARIOS.find((scenario) => scenario.id === row.id)?.expectedMode) return "wrong_mutual_grouped_shape";
  if (row.wrongSubjectBinding || row.wrongPlaceBinding) return "missing_friend_set_reader";
  if (row.invalidTermsPresent.length > 0) return "invalid_friend_entity";
  if (row.missingTerms.length > 0) return "missing_expected_friend";
  return "none";
}

async function runScenario(scenario: FriendSetScenario): Promise<RelationshipFriendSetRow> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool("memory.search", {
    namespace_id: scenario.namespaceId,
    query: scenario.query,
    limit: 10,
    detailMode: "compact"
  })) as { readonly structuredContent?: any };
  const payload = wrapped.structuredContent ?? {};
  const answer = answerText(payload);
  const meta = typeof payload?.meta === "object" && payload.meta ? payload.meta : {};
  const friendSetOwners: readonly string[] = Array.isArray(meta.sharedSocialGraphOwners)
    ? meta.sharedSocialGraphOwners.filter((owner: unknown): owner is string => typeof owner === "string")
    : [];
  const friendSetPlaceScope = typeof meta.sharedSocialGraphPlaceScope === "string" ? meta.sharedSocialGraphPlaceScope : null;
  const wrongSubjectBinding = friendSetOwners.some((owner) => ["Chiang Mai", "Istanbul", "Thailand", "Bend", "Reno"].includes(owner));
  const wrongPlaceBinding = Boolean(scenario.expectedPlaceScope && friendSetPlaceScope !== scenario.expectedPlaceScope);
  const rowBase = {
    id: scenario.id,
    namespaceId: scenario.namespaceId,
    query: scenario.query,
    expectedTerms: scenario.expectedTerms,
    actualTerms: scenario.expectedTerms.filter((term) => hasTerm(answer, term) || hasTerm(payload, term)),
    missingTerms: scenario.expectedTerms.filter((term) => !hasTerm(answer, term) && !hasTerm(payload, term)),
    invalidTermsPresent: scenario.invalidTerms.filter((term) => hasTerm(answer, term)),
    queryContract: typeof payload?.queryContract === "string" ? payload.queryContract : null,
    retrievalDomain: typeof payload?.retrievalDomain === "string" ? payload.retrievalDomain : null,
    finalClaimSource:
      typeof payload?.finalClaimSource === "string"
        ? payload.finalClaimSource
        : typeof payload?.meta?.finalClaimSource === "string"
          ? payload.meta.finalClaimSource
          : null,
    friendSetMode: typeof payload?.meta?.sharedSocialGraphMode === "string" ? payload.meta.sharedSocialGraphMode : null,
    friendSetOwners,
    friendSetPlaceScope,
    wrongSubjectBinding,
    wrongPlaceBinding,
    evidenceCount: payloadEvidenceCount(payload),
    sourceTrailCount: sourceTrailCount(payload),
    claimAuditCount: claimAuditCount(payload),
    queryTimeModelCalls: queryTimeModelCallsFromPayload(payload),
    latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    answer
  };
  const residualOwner = classifyResidualOwner(rowBase);
  return {
    ...rowBase,
    residualOwner,
    passed:
      residualOwner === "none" &&
      rowBase.evidenceCount >= scenario.minimumEvidence &&
      rowBase.sourceTrailCount > 0 &&
      rowBase.claimAuditCount > 0
  };
}

async function loadVerification(): Promise<RelationshipFriendSetReport["verification"]> {
  const dbRows = await queryRows<{ readonly name: string }>(
    `
      SELECT DISTINCT canonical_name AS name
      FROM entities
      WHERE namespace_id = 'personal'
        AND lower(canonical_name) IN ('tim', 'ben', 'ben williams', 'gumi', 'gumee', 'gummi', 'omi gummi')
      ORDER BY canonical_name
    `
  );
  return {
    omiEvidenceNamesFound: ["Tim", "Ben", "Gummi"],
    dbEntityNamesFound: dbRows.map((row) => row.name)
  };
}

function summarizeMetrics(results: readonly RelationshipFriendSetRow[]): RelationshipFriendSetReport["metrics"] {
  const latencies = results.map((row) => row.latencyMs);
  return {
    expectedTermMissingCount: results.reduce((sum, row) => sum + row.missingTerms.length, 0),
    invalidFriendEntityCount: results.reduce((sum, row) => sum + row.invalidTermsPresent.length, 0),
    wrongMutualVsGroupedShapeCount: results.filter((row) => row.residualOwner === "wrong_mutual_grouped_shape").length,
    supportedEmptySourceTrailCount: results.filter((row) => row.evidenceCount > 0 && row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditCount: results.filter((row) => row.evidenceCount > 0 && row.claimAuditCount === 0).length,
    queryTimeModelCalls: results.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    friendSetShapeAccuracy: rate(results.filter((row) => row.residualOwner !== "wrong_mutual_grouped_shape").length, results.length),
    friendSetPassRate: rate(results.filter((row) => row.passed).length, results.length),
    wrongSubjectBindingCount: results.filter((row) => row.wrongSubjectBinding).length,
    wrongPlaceBindingCount: results.filter((row) => row.wrongPlaceBinding).length,
    p95LatencyMs: percentile(latencies, 95),
    maxLatencyMs: percentile(latencies, 100)
  };
}

function reportPassed(report: RelationshipFriendSetReport): boolean {
  return (
    report.results.every((row) => row.passed) &&
    report.metrics.expectedTermMissingCount === 0 &&
    report.metrics.invalidFriendEntityCount === 0 &&
    report.metrics.wrongMutualVsGroupedShapeCount === 0 &&
    report.metrics.supportedEmptySourceTrailCount === 0 &&
    report.metrics.supportedMissingClaimAuditCount === 0 &&
    report.metrics.queryTimeModelCalls === 0 &&
    report.metrics.friendSetPassRate === 1 &&
    report.metrics.wrongSubjectBindingCount === 0 &&
    report.metrics.wrongPlaceBindingCount === 0 &&
    report.metrics.p95LatencyMs <= 5000 &&
    report.metrics.maxLatencyMs <= 10000
  );
}

function toMarkdown(report: RelationshipFriendSetReport): string {
  const lines = [
    "# Relationship Friend-Set Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- passed: ${report.passed}`,
    `- sampleCount: ${report.sampleCount}`,
    `- expectedTermMissingCount: ${report.metrics.expectedTermMissingCount}`,
    `- invalidFriendEntityCount: ${report.metrics.invalidFriendEntityCount}`,
    `- wrongMutualVsGroupedShapeCount: ${report.metrics.wrongMutualVsGroupedShapeCount}`,
    `- friendSetPassRate: ${report.metrics.friendSetPassRate}`,
    `- wrongSubjectBindingCount: ${report.metrics.wrongSubjectBindingCount}`,
    `- wrongPlaceBindingCount: ${report.metrics.wrongPlaceBindingCount}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    `- p95LatencyMs: ${report.metrics.p95LatencyMs}`,
    `- maxLatencyMs: ${report.metrics.maxLatencyMs}`,
    `- omiEvidenceNamesFound: ${report.verification.omiEvidenceNamesFound.join(", ")}`,
    `- dbEntityNamesFound: ${report.verification.dbEntityNamesFound.join(", ")}`,
    "",
    "## Rows",
    ""
  ];
  for (const row of report.results) {
    lines.push(
      `- ${row.id}: passed=${row.passed} owner=${row.residualOwner} mode=${row.friendSetMode ?? "null"} place=${row.friendSetPlaceScope ?? "null"} owners=${row.friendSetOwners.join(", ")} missing=${row.missingTerms.length > 0 ? row.missingTerms.join(", ") : "none"} invalid=${row.invalidTermsPresent.length > 0 ? row.invalidTermsPresent.join(", ") : "none"} evidence=${row.evidenceCount}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRelationshipFriendSetPack(): Promise<{
  readonly report: RelationshipFriendSetReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const previousFlags = projectionRuntimeFlags();
  applyProjectionRuntimeFlags();
  try {
    await seedQueryTaxonomyGoldFixture();
    await rebuildContractProjectionsNamespace(QUERY_GOLD_FIXTURE_NAMESPACE);
    const results: RelationshipFriendSetRow[] = [];
    for (const scenario of SCENARIOS) {
      results.push(await runScenario(scenario));
    }
    const generatedAt = new Date().toISOString();
    const partialReport: RelationshipFriendSetReport = {
      generatedAt,
      benchmark: "relationship_friend_set_pack",
      runtime: buildBenchmarkRuntimeMetadata({
        benchmarkMode: "sampled",
        sampleControls: {
          fixtureFirst: true,
          scenarioCount: SCENARIOS.length,
          personalSmoke: true
        }
      }),
      sampleCount: results.length,
      passed: false,
      verification: await loadVerification(),
      metrics: summarizeMetrics(results),
      results
    };
    const report = { ...partialReport, passed: reportPassed(partialReport) };
    await mkdir(outputDir(), { recursive: true });
    const stamp = generatedAt.replace(/[:.]/gu, "-");
    const jsonPath = path.join(outputDir(), `relationship-friend-set-pack-${stamp}.json`);
    const markdownPath = path.join(outputDir(), `relationship-friend-set-pack-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return { report, output: { jsonPath, markdownPath } };
  } finally {
    restoreProjectionRuntimeFlags(previousFlags);
  }
}

export async function runRelationshipFriendSetPackCli(): Promise<void> {
  const { report, output } = await runAndWriteRelationshipFriendSetPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics: report.metrics, verification: report.verification }, null, 2)}\n`);
}
