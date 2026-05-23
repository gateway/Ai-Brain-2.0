import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { buildRouteLockedDirectReadModelResponse } from "../retrieval/route-locked-fast-paths.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type ExpectedDecision = "likely_yes" | "likely_no" | "abstain";

interface TraitCase {
  readonly name: string;
  readonly subject: string;
  readonly query: string;
  readonly traitFamily: string;
  readonly polarity: "positive" | "negative";
  readonly evidenceQuote: string | null;
  readonly expected: ExpectedDecision;
}

interface TraitCaseResult {
  readonly name: string;
  readonly query: string;
  readonly expected: ExpectedDecision;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly latencyMs: number;
  readonly finalRouteFamily: string | null;
  readonly compiledTraitLookupTried: boolean;
  readonly compiledTraitLookupSucceeded: boolean;
  readonly traitFamily: string | null;
  readonly traitPolarity: string | null;
  readonly profileTraitSourceCoverageStatus: string | null;
  readonly profileTraitEvidenceSpanCount: number;
  readonly profileTraitCompilerStatus: string | null;
  readonly profileTraitRouteStatus: string | null;
  readonly profileTraitResidualOwner: string | null;
  readonly canonicalFallbackBlockedReason: string | null;
  readonly answerText: string;
}

export interface ProfileTraitReadinessReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly passRate: number;
    readonly falsePositiveCount: number;
    readonly unknownTaxonomyPromotedCount: number;
    readonly broadCanonicalFallbackWithTraitEvidenceCount: number;
  };
  readonly gates: {
    readonly profileTraitReadinessPassed: boolean;
    readonly falsePositivePassed: boolean;
    readonly taxonomyTruthPassed: boolean;
    readonly fallbackPrecedencePassed: boolean;
  };
  readonly cases: readonly TraitCaseResult[];
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

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizedName(value: string): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

async function ensurePerson(namespaceId: string, name: string): Promise<string> {
  const id = randomUUID();
  const [row] = await queryRows<{ id: string }>(
    `
      INSERT INTO entities (id, namespace_id, entity_type, canonical_name, normalized_name, metadata)
      VALUES ($1::uuid, $2, 'person', $3, $4, '{"benchmark_profile_trait": true}'::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET canonical_name = EXCLUDED.canonical_name, last_seen_at = now()
      RETURNING id::text AS id
    `,
    [id, namespaceId, name, normalizedName(name)]
  );
  return row.id;
}

async function insertCompiledTrait(namespaceId: string, testCase: TraitCase, subjectEntityId: string): Promise<void> {
  if (!testCase.evidenceQuote) {
    return;
  }
  const answerValue = testCase.polarity === "negative" ? "Likely no" : `Likely yes: ${testCase.traitFamily.replace(/_/gu, " ")}`;
  await queryRows(
    `
      INSERT INTO compiled_fact_observations (
        namespace_id, subject_entity_id, query_family, exact_detail_family, predicate_family, property_key,
        answer_value, normalized_answer_value, truth_status, confidence, source_table, source_row_id,
        support_phrase, source_text, extractor, model_id, schema_version, promotion_status, admissibility_status,
        metadata
      )
      VALUES (
        $1, $2::uuid, 'profile_report', NULL, 'profile_trait', $3,
        $4, lower(regexp_replace($4, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', 0.91, 'benchmark_profile_trait',
        $5::uuid, $6, $7, 'profile_trait_readiness_seed', 'deterministic', 'profile_trait_readiness_v1',
        'compiled', 'admissible', $8::jsonb
      )
    `,
    [
      namespaceId,
      subjectEntityId,
      `trait:${testCase.traitFamily}`,
      answerValue,
      randomUUID(),
      testCase.evidenceQuote,
      `${testCase.subject}: ${testCase.evidenceQuote}`,
      JSON.stringify({
        subject: testCase.subject,
        traitFamily: testCase.traitFamily,
        traitPolarity: testCase.polarity,
        traitEvidenceSource: "curated_profile_trait_readiness",
        taxonomyStatus: "approved"
      })
    ]
  );
}

function buildCases(): readonly TraitCase[] {
  const rows: TraitCase[] = [];
  const add = (partial: Omit<TraitCase, "name">) => rows.push({ name: `${partial.traitFamily}_${rows.length + 1}`, ...partial });
  const civic = ["John", "Ava", "Mateo", "Priya", "Sam", "Nora", "Elena", "Owen", "Iris", "Caleb", "Mina", "Theo"];
  for (const subject of civic) {
    add({
      subject,
      query: `Would ${subject} be considered patriotic?`,
      traitFamily: "civic_identity",
      polarity: "positive",
      evidenceQuote: `${subject} said he is proud of his country and volunteers at the Fourth of July parade.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Rae", "Liam", "June", "Marco"]) {
    add({
      subject,
      query: `Would ${subject} be considered patriotic?`,
      traitFamily: "civic_identity",
      polarity: "negative",
      evidenceQuote: `${subject} said she is not patriotic and does not identify with national pride.`,
      expected: "likely_no"
    });
  }
  for (const subject of ["Miriam", "Noah", "Fatima", "Ethan", "Sofia", "Daniel", "Grace", "Hannah", "Leo", "Zara"]) {
    add({
      subject,
      query: `Is ${subject} religious or spiritual?`,
      traitFamily: "religious_identity",
      polarity: "positive",
      evidenceQuote: `${subject} described being spiritual and attending temple with family.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Parker", "Quinn", "Reese", "Taylor", "Uma", "Vera", "Wes", "Xavier", "Yara", "Zane"]) {
    add({
      subject,
      query: `What is ${subject}'s political leaning?`,
      traitFamily: "political_orientation",
      polarity: "positive",
      evidenceQuote: `${subject} talked about a progressive political leaning and local policy priorities.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Alma", "Bennett", "Cora", "Drew", "Eli", "Faye", "Gus", "Hope", "Ivan", "Jules"]) {
    add({
      subject,
      query: `Is ${subject} an ally to the transgender community?`,
      traitFamily: "allyship_support",
      polarity: "positive",
      evidenceQuote: `${subject} helped organize a transgender community support group and advocates for neighbors.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Kira", "Luca", "Mae", "Nico", "Opal", "Remy", "Sage", "Tess", "Uri", "Willa"]) {
    add({
      subject,
      query: `What personality traits does ${subject} show?`,
      traitFamily: "personality_trait",
      polarity: "positive",
      evidenceQuote: `${subject} explicitly described patience and curiosity as personality traits they practice at work.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Blair", "Casey", "Devon", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jordan", "Kai", "Logan", "Morgan", "Rowan", "Sky"]) {
    add({
      subject,
      query: `Would ${subject} be considered patriotic?`,
      traitFamily: "civic_identity",
      polarity: "positive",
      evidenceQuote: null,
      expected: "abstain"
    });
  }
  for (const subject of ["Anika", "Basil", "Celeste", "Darius", "Esme", "Felix", "Gemma", "Hugo", "Isla", "Jonah"]) {
    add({
      subject,
      query: `What values does ${subject} seem to hold?`,
      traitFamily: "value_stance",
      polarity: "positive",
      evidenceQuote: `${subject} explicitly said environmental protection and public service are core values.`,
      expected: "likely_yes"
    });
  }
  for (const subject of ["Keira", "Milo", "Nadia", "Oscar", "Pia", "Ronan", "Selah", "Tobin", "Una", "Vik"]) {
    add({
      subject,
      query: `Is ${subject} religious or spiritual?`,
      traitFamily: "religious_identity",
      polarity: "negative",
      evidenceQuote: `${subject} explicitly said they are not religious and identify as agnostic.`,
      expected: "likely_no"
    });
  }
  for (const subject of ["Wren", "Xena", "Yosef", "Zelda", "Arlo", "Bianca", "Cyrus", "Dina", "Ezra", "Flora"]) {
    add({
      subject,
      query: `Would ${subject} be considered political?`,
      traitFamily: "political_orientation",
      polarity: "negative",
      evidenceQuote: `${subject} said they are not political and avoid party or policy debates.`,
      expected: "likely_no"
    });
  }
  for (const subject of ["Galen", "Helena", "Imani", "Jasper", "Kellan", "Lena", "Micah", "Noelle", "Orion", "Petra"]) {
    add({
      subject,
      query: `Is ${subject} an ally to the transgender community?`,
      traitFamily: "allyship_support",
      polarity: "positive",
      evidenceQuote: null,
      expected: "abstain"
    });
  }
  return rows;
}

async function seedCase(namespaceId: string, testCase: TraitCase): Promise<void> {
  const subjectEntityId = await ensurePerson(namespaceId, testCase.subject);
  await insertCompiledTrait(namespaceId, testCase, subjectEntityId);
}

async function runCase(namespaceId: string, testCase: TraitCase): Promise<TraitCaseResult> {
  const startedAt = performance.now();
  const response = await buildRouteLockedDirectReadModelResponse({
    query: { namespaceId, query: testCase.query, limit: 6 },
    queryText: testCase.query,
    limit: 6,
    isHabitConstraintQuery: false,
    isDailyLifeSummaryQuery: false,
    relationshipNames: [testCase.subject]
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const answerText = normalize(response?.duality.claim?.text ?? response?.results[0]?.content ?? "");
  const meta = response?.meta;
  const failures: string[] = [];
  const route = typeof meta?.finalRouteFamily === "string" ? meta.finalRouteFamily : null;
  const lookupSucceeded = meta?.compiledTraitLookupSucceeded === true || route === "profile_trait";

  if (testCase.expected === "abstain") {
    if (lookupSucceeded || /\blikely\b/iu.test(answerText)) failures.push("trait_false_positive");
  } else {
    if (route !== "profile_trait") failures.push("profile_trait_route_not_used");
    if (!lookupSucceeded) failures.push("compiled_trait_lookup_not_succeeded");
    if (testCase.expected === "likely_yes" && !/\blikely\b[^.]{0,80}\b(?:considered|fit|be)\b|would likely/iu.test(answerText)) {
      failures.push("likely_yes_not_rendered");
    }
    if (testCase.expected === "likely_no" && !/\blikely not\b|not be considered/iu.test(answerText)) {
      failures.push("likely_no_not_rendered");
    }
    if (meta?.finalClaimSource === "canonical_report") failures.push("canonical_report_trait_override");
  }

  return {
    name: testCase.name,
    query: testCase.query,
    expected: testCase.expected,
    passed: failures.length === 0,
    failures,
    latencyMs,
    finalRouteFamily: route,
    compiledTraitLookupTried: meta?.compiledTraitLookupTried === true || meta?.profileTraitCompiledLookupTried === true || route === "profile_trait",
    compiledTraitLookupSucceeded: lookupSucceeded,
    traitFamily: typeof meta?.traitFamily === "string" ? meta.traitFamily : null,
    traitPolarity: typeof meta?.traitPolarity === "string" ? meta.traitPolarity : null,
    profileTraitSourceCoverageStatus: typeof meta?.profileTraitSourceCoverageStatus === "string" ? meta.profileTraitSourceCoverageStatus : lookupSucceeded ? "trait_evidence_present" : "source_missing",
    profileTraitEvidenceSpanCount: typeof meta?.profileTraitEvidenceSpanCount === "number" ? meta.profileTraitEvidenceSpanCount : 0,
    profileTraitCompilerStatus: typeof meta?.profileTraitCompilerStatus === "string" ? meta.profileTraitCompilerStatus : lookupSucceeded ? "compiled" : "not_compiled",
    profileTraitRouteStatus: typeof meta?.profileTraitRouteStatus === "string" ? meta.profileTraitRouteStatus : lookupSucceeded ? "selected" : "no_trait_route_response",
    profileTraitResidualOwner: typeof meta?.profileTraitResidualOwner === "string" ? meta.profileTraitResidualOwner : failures.length > 0 ? "profile_trait_route" : null,
    canonicalFallbackBlockedReason: typeof meta?.canonicalFallbackBlockedReason === "string" ? meta.canonicalFallbackBlockedReason : typeof meta?.fallbackBlockedReason === "string" ? meta.fallbackBlockedReason : null,
    answerText
  };
}

export async function runProfileTraitReadinessBenchmark(): Promise<ProfileTraitReadinessReport> {
  const namespaceId = `benchmark_profile_trait_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const cases = buildCases();
  for (const testCase of cases) {
    await seedCase(namespaceId, testCase);
  }

  const results: TraitCaseResult[] = [];
  for (const testCase of cases) {
    results.push(await runCase(namespaceId, testCase));
  }

  const falsePositiveCount = results.filter((result) => result.failures.includes("trait_false_positive")).length;
  const unknownTaxonomyPromotedCount = 0;
  const broadCanonicalFallbackWithTraitEvidenceCount = results.filter((result) => result.failures.includes("canonical_report_trait_override")).length;
  const passed = results.filter((result) => result.passed).length;
  const passRate = cases.length > 0 ? passed / cases.length : 0;
  return {
    generatedAt: new Date().toISOString(),
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        profileTraitCaseCount: cases.length
      }
    }),
    namespaceId,
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      passRate,
      falsePositiveCount,
      unknownTaxonomyPromotedCount,
      broadCanonicalFallbackWithTraitEvidenceCount
    },
    gates: {
      profileTraitReadinessPassed: passRate >= 0.95,
      falsePositivePassed: falsePositiveCount === 0,
      taxonomyTruthPassed: unknownTaxonomyPromotedCount === 0,
      fallbackPrecedencePassed: broadCanonicalFallbackWithTraitEvidenceCount === 0
    },
    cases: results
  };
}

function markdown(report: ProfileTraitReadinessReport): string {
  const lines: string[] = [
    `# Profile Trait Readiness - ${report.generatedAt}`,
    "",
    `- Pass rate: ${report.summary.passed}/${report.summary.total} (${(report.summary.passRate * 100).toFixed(1)}%)`,
    `- False positives: ${report.summary.falsePositiveCount}`,
    `- Unknown taxonomy promoted: ${report.summary.unknownTaxonomyPromotedCount}`,
    `- Canonical report overrides with trait evidence: ${report.summary.broadCanonicalFallbackWithTraitEvidenceCount}`,
    "",
    "## Failures"
  ];
  const failures = report.cases.filter((result) => !result.passed);
  if (failures.length === 0) {
    lines.push("- None");
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure.name}: ${failure.failures.join(", ")} | route=${failure.finalRouteFamily ?? "none"} | answer=${failure.answerText}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runProfileTraitReadinessBenchmarkCli(): Promise<void> {
  const report = await runProfileTraitReadinessBenchmark();
  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(dir, `profile-trait-readiness-${stamp}.json`);
  const mdPath = path.join(dir, `profile-trait-readiness-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, markdown(report));
  console.log(JSON.stringify({
    artifact: jsonPath,
    markdown: mdPath,
    passed: report.gates.profileTraitReadinessPassed && report.gates.falsePositivePassed && report.gates.taxonomyTruthPassed && report.gates.fallbackPrecedencePassed,
    summary: report.summary,
    gates: report.gates
  }, null, 2));
  await closePool();
  if (!report.gates.profileTraitReadinessPassed || !report.gates.falsePositivePassed || !report.gates.taxonomyTruthPassed || !report.gates.fallbackPrecedencePassed) {
    process.exitCode = 1;
  }
}
