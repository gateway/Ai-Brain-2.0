import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows } from "../db/client.js";
import { runUniversalMutableReconsolidation } from "../jobs/memory-reconsolidation.js";
import { searchMemory } from "../retrieval/service.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

type Verdict = "pass" | "warning" | "fail";

interface QueryScenario {
  readonly name: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedConfidence: "confident" | "weak" | "missing";
  readonly expectedSynthesisMode: "recall" | "reflect";
  readonly expectedGlobalQueryRouted?: boolean;
}

interface QueryScenarioResult {
  readonly name: string;
  readonly query: string;
  readonly confidence: string | null;
  readonly synthesisMode: string | null;
  readonly globalQueryRouted: boolean;
  readonly summaryRoutingUsed: boolean;
  readonly evidenceCount: number;
  readonly latencyMs: number;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

interface SnapshotCheckResult {
  readonly name: string;
  readonly verdict: Verdict;
  readonly failures: readonly string[];
}

export interface ProfileRoutingReviewReport {
  readonly generatedAt: string;
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly namespaceId: string;
  readonly snapshotChecks: readonly SnapshotCheckResult[];
  readonly queryScenarios: readonly QueryScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly warning: number;
    readonly fail: number;
  };
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

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null).toLowerCase();
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).includes(term.toLowerCase());
}

function approxTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/u).filter(Boolean).length * 1.3));
}

async function insertSourceEpisodic(
  namespaceId: string,
  content: string,
  occurredAt: string,
  metadata: Record<string, unknown>
): Promise<string> {
  const checksum = `benchmark-${randomUUID()}`;
  const uri = `benchmark://profile-routing/${checksum}.md`;
  const [artifact] = await queryRows<{ artifact_id: string }>(
    `
      INSERT INTO artifacts (
        namespace_id,
        artifact_type,
        uri,
        latest_checksum_sha256,
        mime_type,
        source_channel,
        metadata
      )
      VALUES ($1, 'markdown_session', $2, $3, 'text/markdown', 'benchmark', $4::jsonb)
      RETURNING id AS artifact_id
    `,
    [namespaceId, uri, checksum, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [observation] = await queryRows<{ observation_id: string }>(
    `
      INSERT INTO artifact_observations (
        artifact_id,
        version,
        checksum_sha256,
        byte_size,
        observed_at,
        metadata
      )
      VALUES ($1, 1, $2, $3, $4::timestamptz, $5::jsonb)
      RETURNING id AS observation_id
    `,
    [artifact.artifact_id, checksum, content.length, occurredAt, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [chunk] = await queryRows<{ chunk_id: string }>(
    `
      INSERT INTO artifact_chunks (
        artifact_id,
        artifact_observation_id,
        chunk_index,
        char_start,
        char_end,
        text_content,
        metadata
      )
      VALUES ($1, $2, 0, 0, $3, $4, $5::jsonb)
      RETURNING id AS chunk_id
    `,
    [artifact.artifact_id, observation.observation_id, content.length, content, JSON.stringify({ benchmark_seed: true, ...metadata })]
  );
  const [episodic] = await queryRows<{ memory_id: string }>(
    `
      INSERT INTO episodic_memory (
        namespace_id,
        session_id,
        role,
        content,
        occurred_at,
        captured_at,
        artifact_id,
        artifact_observation_id,
        source_chunk_id,
        source_offset,
        token_count,
        metadata
      )
      VALUES ($1, $2, 'import', $3, $4::timestamptz, $4::timestamptz, $5, $6, $7, $8::jsonb, $9, $10::jsonb)
      RETURNING id AS memory_id
    `,
    [
      namespaceId,
      "benchmark_profile_routing",
      content,
      occurredAt,
      artifact.artifact_id,
      observation.observation_id,
      chunk.chunk_id,
      JSON.stringify({ char_start: 0, char_end: content.length }),
      approxTokenCount(content),
      JSON.stringify({ benchmark_seed: true, ...metadata })
    ]
  );
  return episodic.memory_id;
}

async function insertProcedural(
  namespaceId: string,
  stateType: string,
  stateKey: string,
  stateValue: Record<string, unknown>,
  validFrom: string,
  validUntil: string | null,
  version: number,
  supersedesId: string | null = null
): Promise<string> {
  const sourceMemoryId = await insertSourceEpisodic(
    namespaceId,
    `${stateType} ${stateKey}\n${JSON.stringify(stateValue)}`,
    validFrom,
    { state_type: stateType, state_key: stateKey, source: "profile_routing_review" }
  );
  const [row] = await queryRows<{ id: string }>(
    `
      INSERT INTO procedural_memory (
        namespace_id,
        state_type,
        state_key,
        state_value,
        version,
        updated_at,
        valid_from,
        valid_until,
        supersedes_id,
        metadata
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz, $8, $9::jsonb)
      RETURNING id
    `,
    [
      namespaceId,
      stateType,
      stateKey,
      JSON.stringify({
        ...stateValue,
        source_memory_id: sourceMemoryId
      }),
      version,
      validFrom,
      validUntil,
      supersedesId,
      JSON.stringify({ benchmark_seed: true, source: "profile_routing_review" })
    ]
  );
  return row.id;
}

async function loadProfileSummary(
  namespaceId: string,
  canonicalKey: string
): Promise<{ readonly id: string; readonly content: string; readonly status: string } | null> {
  const rows = await queryRows<{ id: string; content: string; status: string }>(
    `
      SELECT id::text AS id, content_abstract AS content, status
      FROM semantic_memory
      WHERE namespace_id = $1
        AND canonical_key = $2
      ORDER BY valid_from DESC, id DESC
    `,
    [namespaceId, canonicalKey]
  );
  return rows[0] ?? null;
}

async function loadProfileSummaryHistory(
  namespaceId: string,
  canonicalKey: string
): Promise<readonly { id: string; content: string; status: string }[]> {
  return queryRows<{ id: string; content: string; status: string }>(
    `
      SELECT id::text AS id, content_abstract AS content, status
      FROM semantic_memory
      WHERE namespace_id = $1
        AND canonical_key = $2
      ORDER BY valid_from DESC, id DESC
    `,
    [namespaceId, canonicalKey]
  );
}

async function seedProfileScenario(namespaceId: string): Promise<void> {
  await insertProcedural(
    namespaceId,
    "current_employer",
    "ava_current_employer",
    { person: "Ava Chen", organization: "Northstar Labs" },
    "2026-03-20T09:00:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "project_role",
    "ava_role",
    { person: "Ava Chen", role: "research lead", project: "Atlas" },
    "2026-03-20T09:05:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "current_project",
    "ava_project",
    { person: "Ava Chen", project: "Atlas patient-support pilot" },
    "2026-03-20T09:06:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "current_location",
    "ava_location",
    { person: "Ava Chen", place: "Chiang Mai" },
    "2026-03-20T09:07:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "goal",
    "ava_goal",
    { person: "Ava Chen", goal: "launch the patient-support pilot" },
    "2026-03-20T09:08:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "plan",
    "ava_plan",
    { person: "Ava Chen", plan: "ship onboarding and interview users" },
    "2026-03-20T09:09:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "preference",
    "ava_preference_tea",
    { person: "Ava Chen", category: "drink", target: "green tea", polarity: "like" },
    "2026-03-20T09:10:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "skill",
    "ava_skill",
    { person: "Ava Chen", skill: "Muay Thai" },
    "2026-03-20T09:11:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "current_relationship",
    "ava_relationship",
    { person: "Ava Chen", partner_name: "Jules" },
    "2026-03-20T09:12:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "goal",
    "ben_goal",
    { person: "Ben Ortiz", goal: "launch the patient-support pilot" },
    "2026-03-20T10:00:00.000Z",
    null,
    1
  );
  await insertProcedural(
    namespaceId,
    "plan",
    "ben_plan",
    { person: "Ben Ortiz", plan: "support the pilot interviews" },
    "2026-03-20T10:05:00.000Z",
    null,
    1
  );
}

async function applyEmployerSupersession(namespaceId: string): Promise<void> {
  const rows = await queryRows<{ id: string }>(
    `
      SELECT id::text AS id
      FROM procedural_memory
      WHERE namespace_id = $1
        AND state_type = 'current_employer'
        AND state_key = 'ava_current_employer'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [namespaceId]
  );
  const priorId = rows[0]?.id ?? null;
  if (priorId) {
    await queryRows(
      `
        UPDATE procedural_memory
        SET valid_until = $2::timestamptz
        WHERE id = $1::uuid
      `,
      [priorId, "2026-03-22T09:00:00.000Z"]
    );
  }
  await insertProcedural(
    namespaceId,
    "current_employer",
    "ava_current_employer",
    { person: "Ava Chen", organization: "Harbor Health" },
    "2026-03-22T09:00:00.000Z",
    null,
    2,
    priorId
  );
  await insertProcedural(
    namespaceId,
    "project_role",
    "ava_role",
    { person: "Ava Chen", role: "product strategist", project: "Harbor Care rollout" },
    "2026-03-22T09:02:00.000Z",
    null,
    2
  );
  await insertProcedural(
    namespaceId,
    "current_project",
    "ava_project",
    { person: "Ava Chen", project: "Harbor Care rollout" },
    "2026-03-22T09:03:00.000Z",
    null,
    2
  );
}

async function runQueryScenario(namespaceId: string, scenario: QueryScenario): Promise<QueryScenarioResult> {
  const startedAt = performance.now();
  const response = await searchMemory({
    namespaceId,
    query: scenario.query,
    limit: 8
  });
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const failures: string[] = [];
  const confidence = response.meta.answerAssessment?.confidence ?? null;
  const synthesisMode = response.meta.synthesisMode ?? null;
  const globalQueryRouted = response.meta.globalQueryRouted === true;
  const summaryRoutingUsed = response.meta.summaryRoutingUsed === true;

  for (const term of scenario.expectedTerms) {
    if (!hasTerm(response, term)) {
      failures.push(`missing term ${term}`);
    }
  }
  if (confidence !== scenario.expectedConfidence) {
    failures.push(`expected confidence ${scenario.expectedConfidence}, got ${confidence ?? "n/a"}`);
  }
  if (synthesisMode !== scenario.expectedSynthesisMode) {
    failures.push(`expected synthesis mode ${scenario.expectedSynthesisMode}, got ${synthesisMode ?? "n/a"}`);
  }
  if (typeof scenario.expectedGlobalQueryRouted === "boolean" && globalQueryRouted !== scenario.expectedGlobalQueryRouted) {
    failures.push(`expected globalQueryRouted ${scenario.expectedGlobalQueryRouted}, got ${globalQueryRouted}`);
  }

  return {
    name: scenario.name,
    query: scenario.query,
    confidence,
    synthesisMode,
    globalQueryRouted,
    summaryRoutingUsed,
    evidenceCount: response.evidence.length,
    latencyMs,
    verdict: failures.length === 0 ? "pass" : "fail",
    failures
  };
}

function toMarkdown(report: ProfileRoutingReviewReport): string {
  const lines = [
    "# Profile Routing Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- benchmarkMode: ${report.runtime.benchmarkMode}`,
    `- retrievalFusionVersion: ${report.runtime.retrievalFusionVersion}`,
    `- rerankerVersion: ${report.runtime.rerankerVersion}`,
    `- relationIeSchemaVersion: ${report.runtime.relationIeSchemaVersion}`,
    "",
    "## Snapshot Checks",
    ""
  ];

  for (const check of report.snapshotChecks) {
    lines.push(`- ${check.name}: ${check.verdict}`);
    for (const failure of check.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("", "## Query Scenarios", "");
  for (const scenario of report.queryScenarios) {
    lines.push(
      `- ${scenario.name}: ${scenario.verdict} | confidence=${scenario.confidence ?? "n/a"} | synthesisMode=${scenario.synthesisMode ?? "n/a"} | global=${scenario.globalQueryRouted} | summaryRouting=${scenario.summaryRoutingUsed} | evidence=${scenario.evidenceCount} | latencyMs=${scenario.latencyMs}`
    );
    lines.push(`  - q: ${scenario.query}`);
    for (const failure of scenario.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteProfileRoutingReviewBenchmark(): Promise<{
  readonly report: ProfileRoutingReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const namespaceId = `benchmark_profile_routing_${stamp}`;

  await seedProfileScenario(namespaceId);
  await runUniversalMutableReconsolidation(namespaceId);

  const snapshotChecks: SnapshotCheckResult[] = [];
  const currentPictureKey = "reconsolidated:profile_summary:current_picture:ava_chen";
  const focusKey = "reconsolidated:profile_summary:focus:ava_chen";
  const roleKey = "reconsolidated:profile_summary:role_direction:ava_chen";

  const firstCurrentPicture = await loadProfileSummary(namespaceId, currentPictureKey);
  const firstFocus = await loadProfileSummary(namespaceId, focusKey);
  const firstRole = await loadProfileSummary(namespaceId, roleKey);

  snapshotChecks.push({
    name: "profile_snapshots_created",
    verdict:
      firstCurrentPicture && firstFocus && firstRole &&
      hasTerm(firstCurrentPicture.content, "Northstar Labs") &&
      hasTerm(firstCurrentPicture.content, "Chiang Mai") &&
      hasTerm(firstFocus.content, "patient-support pilot") &&
      hasTerm(firstRole.content, "research lead")
        ? "pass"
        : "fail",
    failures: [
      !firstCurrentPicture ? "missing current_picture profile summary" : "",
      !firstFocus ? "missing focus profile summary" : "",
      !firstRole ? "missing role_direction profile summary" : "",
      firstCurrentPicture && !hasTerm(firstCurrentPicture.content, "Northstar Labs") ? "current picture missing Northstar Labs" : "",
      firstCurrentPicture && !hasTerm(firstCurrentPicture.content, "Chiang Mai") ? "current picture missing Chiang Mai" : "",
      firstFocus && !hasTerm(firstFocus.content, "patient-support pilot") ? "focus summary missing pilot goal" : "",
      firstRole && !hasTerm(firstRole.content, "research lead") ? "role_direction summary missing research lead" : ""
    ].filter(Boolean)
  });

  await applyEmployerSupersession(namespaceId);
  await runUniversalMutableReconsolidation(namespaceId);

  const updatedCurrentPictureHistory = await loadProfileSummaryHistory(namespaceId, currentPictureKey);
  const activeCurrentPicture = updatedCurrentPictureHistory.find((item) => item.status === "active") ?? null;
  const supersededCurrentPicture = updatedCurrentPictureHistory.find((item) => item.status === "superseded" && hasTerm(item.content, "Northstar Labs")) ?? null;

  snapshotChecks.push({
    name: "profile_snapshot_supersession",
    verdict:
      activeCurrentPicture &&
      supersededCurrentPicture &&
      hasTerm(activeCurrentPicture.content, "Harbor Health") &&
      hasTerm(activeCurrentPicture.content, "Harbor Care rollout")
        ? "pass"
        : "fail",
    failures: [
      !activeCurrentPicture ? "missing active superseded current_picture row" : "",
      activeCurrentPicture && !hasTerm(activeCurrentPicture.content, "Harbor Health") ? "active current_picture missing Harbor Health" : "",
      activeCurrentPicture && !hasTerm(activeCurrentPicture.content, "Harbor Care rollout") ? "active current_picture missing Harbor Care rollout" : "",
      !supersededCurrentPicture ? "missing superseded Northstar current_picture row" : ""
    ].filter(Boolean)
  });

  const queryScenarios = await Promise.all([
    runQueryScenario(namespaceId, {
      name: "broad_current_picture_reflect",
      query: "What has Ava Chen been doing lately?",
      expectedTerms: ["Harbor Health", "Harbor Care rollout", "Chiang Mai"],
      expectedConfidence: "confident",
      expectedSynthesisMode: "reflect",
      expectedGlobalQueryRouted: true
    }),
    runQueryScenario(namespaceId, {
      name: "exact_current_state_recall",
      query: "Where does Ava Chen live?",
      expectedTerms: ["Chiang Mai"],
      expectedConfidence: "confident",
      expectedSynthesisMode: "recall",
      expectedGlobalQueryRouted: false
    }),
    runQueryScenario(namespaceId, {
      name: "profile_role_direction_reflect",
      query: "What kind of role does Ava Chen seem drawn toward?",
      expectedTerms: ["product strategist", "Harbor Health"],
      expectedConfidence: "confident",
      expectedSynthesisMode: "reflect",
      expectedGlobalQueryRouted: false
    }),
    runQueryScenario(namespaceId, {
      name: "shared_focus_reflect",
      query: "What do Ava Chen and Ben Ortiz both care about?",
      expectedTerms: ["patient-support pilot"],
      expectedConfidence: "confident",
      expectedSynthesisMode: "reflect",
      expectedGlobalQueryRouted: false
    })
  ]);

  const allItems = [...snapshotChecks, ...queryScenarios];
  const summary = {
    pass: allItems.filter((item) => item.verdict === "pass").length,
    warning: allItems.filter((item) => item.verdict === "warning").length,
    fail: allItems.filter((item) => item.verdict === "fail").length
  };

  const report: ProfileRoutingReviewReport = {
    generatedAt,
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenario_count: queryScenarios.length,
        snapshot_checks: snapshotChecks.length
      }
    }),
    namespaceId,
    snapshotChecks,
    queryScenarios,
    summary
  };

  const dir = outputDir();
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `profile-routing-review-${stamp}.json`);
  const markdownPath = path.join(dir, `profile-routing-review-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");

  return {
    report,
    output: { jsonPath, markdownPath }
  };
}

export async function runProfileRoutingReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteProfileRoutingReviewBenchmark();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
