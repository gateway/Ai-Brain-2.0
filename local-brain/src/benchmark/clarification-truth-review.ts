import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { applyStoredClarificationResolutions, getClarificationInbox, processBrainOutboxEvents, resolveClarification } from "../clarifications/service.js";
import { ingestArtifact } from "../ingest/worker.js";
import { upsertNamespaceSelfProfile } from "../identity/service.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { refreshRelationshipPriors } from "../jobs/relationship-priors.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { executeMcpTool } from "../mcp/server.js";
import { rebuildTypedMemoryNamespace } from "../typed-memory/service.js";
import { resetNamespaceData } from "../cli/reset-namespace.js";

interface FixtureFile {
  readonly name: string;
  readonly relativePath: string;
  readonly capturedAt: string;
  readonly body: string;
}

interface ScenarioResult {
  readonly name: string;
  readonly phase: "unresolved" | "resolved" | "replay";
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly note?: string;
}

export interface ClarificationTruthReviewReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly fixtureRoot: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly summary: {
    readonly pass: number;
    readonly fail: number;
  };
}

interface InsertCandidateInput {
  readonly namespaceId: string;
  readonly sceneId?: string | null;
  readonly occurredAt: string;
  readonly claimType: string;
  readonly predicate: string;
  readonly subjectText?: string | null;
  readonly subjectEntityType?: string | null;
  readonly subjectEntityId?: string | null;
  readonly objectText?: string | null;
  readonly objectEntityType?: string | null;
  readonly objectEntityId?: string | null;
  readonly ambiguityType: string;
  readonly ambiguityReason: string;
  readonly metadata?: Record<string, unknown>;
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

function generatedRoot(): string {
  return path.resolve(localBrainRoot(), "benchmark-generated", "clarification-truth");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasTerm(value: unknown, term: string): boolean {
  return JSON.stringify(value ?? null).toLowerCase().includes(term.toLowerCase());
}

function unwrapStructured(value: unknown): any {
  return (value as { readonly structuredContent?: unknown })?.structuredContent ?? value;
}

function fixtures(): readonly FixtureFile[] {
  return [
    {
      name: "uncle",
      relativePath: "2026/03/29/2026-03-29T02-10-00Z__clarification__uncle.md",
      capturedAt: "2026-03-29T02:10:00.000Z",
      body: "# Uncle\n\nUncle lives up by Lake Tahoe.\n"
    },
    {
      name: "doctor",
      relativePath: "2026/03/29/2026-03-29T02-11-00Z__clarification__doctor.md",
      capturedAt: "2026-03-29T02:11:00.000Z",
      body: "# Doctor\n\nThe doctor works at Chiang Mai Clinic.\n"
    },
    {
      name: "summer_cabin",
      relativePath: "2026/03/29/2026-03-29T02-12-00Z__clarification__summer-cabin.md",
      capturedAt: "2026-03-29T02:12:00.000Z",
      body: "# Summer Cabin\n\nSteve kept talking about the summer cabin, but never wrote down the exact place.\n"
    },
    {
      name: "alex",
      relativePath: "2026/03/29/2026-03-29T02-13-00Z__clarification__alex.md",
      capturedAt: "2026-03-29T02:13:00.000Z",
      body: "# Alex\n\nAlex works with Steve, but the note never says which Alex.\n"
    },
    {
      name: "kozimui",
      relativePath: "2026/03/29/2026-03-29T02-14-00Z__clarification__kozimui.md",
      capturedAt: "2026-03-29T02:14:00.000Z",
      body: "# Kozimui\n\nThe note says Kozimui, which sounds like a place in Thailand.\n"
    }
  ];
}

async function writeFixtures(namespaceId: string): Promise<{ readonly rootPath: string; readonly files: readonly FixtureFile[] }> {
  const rootPath = path.join(generatedRoot(), namespaceId);
  await rm(rootPath, { recursive: true, force: true });
  for (const fixture of fixtures()) {
    const filePath = path.join(rootPath, fixture.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, fixture.body, "utf8");
  }
  return {
    rootPath,
    files: fixtures()
  };
}

async function ingestFixtures(namespaceId: string, rootPath: string, files: readonly FixtureFile[]): Promise<void> {
  for (const fixture of files) {
    await ingestArtifact({
      namespaceId,
      inputUri: path.join(rootPath, fixture.relativePath),
      sourceType: "markdown",
      sourceChannel: "benchmark:clarification_truth",
      capturedAt: fixture.capturedAt,
      skipNarrativeClaims: true,
      metadata: {
        benchmark: "clarification_truth_review",
        fixture: fixture.name
      }
    });
  }
}

async function upsertEntity(namespaceId: string, entityType: string, canonicalName: string): Promise<string> {
  const rows = await queryRows<{ readonly id: string }>(
    `
      INSERT INTO entities (
        namespace_id,
        entity_type,
        canonical_name,
        normalized_name,
        metadata
      )
      VALUES ($1, $2, $3, lower($3), $4::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id::text AS id
    `,
    [
      namespaceId,
      entityType,
      canonicalName,
      JSON.stringify({
        benchmark: "clarification_truth_review"
      })
    ]
  );

  return rows[0]!.id;
}

async function insertClaimCandidate(input: InsertCandidateInput): Promise<string> {
  const rows = await queryRows<{ readonly id: string }>(
    `
      INSERT INTO claim_candidates (
        namespace_id,
        source_scene_id,
        claim_type,
        subject_text,
        subject_entity_type,
        subject_entity_id,
        predicate,
        object_text,
        object_entity_type,
        object_entity_id,
        normalized_text,
        confidence,
        status,
        occurred_at,
        extraction_method,
        ambiguity_state,
        ambiguity_type,
        ambiguity_reason,
        metadata,
        time_granularity,
        anchor_basis
      )
      VALUES (
        $1,
        $2::uuid,
        $3,
        $4,
        $5,
        $6::uuid,
        $7,
        $8,
        $9,
        $10::uuid,
        $11,
        0.74,
        'pending',
        $12::timestamptz,
        'benchmark_clarification_truth',
        'requires_clarification',
        $13,
        $14,
        $15::jsonb,
        'unknown',
        'fallback'
      )
      RETURNING id::text AS id
    `,
    [
      input.namespaceId,
      input.sceneId ?? null,
      input.claimType,
      input.subjectText ?? null,
      input.subjectEntityType ?? null,
      input.subjectEntityId ?? null,
      input.predicate,
      input.objectText ?? null,
      input.objectEntityType ?? null,
      input.objectEntityId ?? null,
      normalizeText([input.subjectText ?? "", input.predicate, input.objectText ?? ""].join(" ")),
      input.occurredAt,
      input.ambiguityType,
      input.ambiguityReason,
      JSON.stringify({
        benchmark: "clarification_truth_review",
        raw_ambiguous_text: input.subjectEntityId || !input.subjectText ? input.objectText ?? null : input.subjectText,
        ...(input.metadata ?? {})
      })
    ]
  );

  return rows[0]!.id;
}

async function seedAmbiguousClaims(namespaceId: string): Promise<void> {
  await upsertNamespaceSelfProfile({
    namespaceId,
    canonicalName: "Steve Tietze",
    aliases: ["Steve"],
    note: "Clarification truth benchmark self anchor."
  });

  const selfRows = await queryRows<{ readonly id: string }>(
    `
      SELECT id::text AS id
      FROM entities
      WHERE namespace_id = $1
        AND entity_type = 'self'
      LIMIT 1
    `,
    [namespaceId]
  );
  const selfId = selfRows[0]?.id;
  if (!selfId) {
    throw new Error("Missing self entity for clarification truth benchmark.");
  }

  const [lakeTahoeId, thailandId, clinicId] = await Promise.all([
    upsertEntity(namespaceId, "place", "Lake Tahoe"),
    upsertEntity(namespaceId, "place", "Thailand"),
    upsertEntity(namespaceId, "org", "Chiang Mai Clinic")
  ]);

  await insertClaimCandidate({
    namespaceId,
    occurredAt: "2026-03-29T02:10:00.000Z",
    claimType: "relationship",
    predicate: "lives_in",
    subjectText: "Uncle",
    subjectEntityType: "person",
    objectText: "Lake Tahoe",
    objectEntityType: "place",
    objectEntityId: lakeTahoeId,
    ambiguityType: "kinship_resolution",
    ambiguityReason: 'The subject reference "Uncle" still needs a canonical person.',
    metadata: {
      suggested_matches: ["Billy Smith", "Joe Bob"]
    }
  });

  await insertClaimCandidate({
    namespaceId,
    occurredAt: "2026-03-29T02:11:00.000Z",
    claimType: "relationship",
    predicate: "works_at",
    subjectText: "doctor",
    subjectEntityType: "person",
    objectText: "Chiang Mai Clinic",
    objectEntityType: "org",
    objectEntityId: clinicId,
    ambiguityType: "unknown_reference",
    ambiguityReason: 'The subject reference "doctor" is still unresolved.',
    metadata: {
      source_kind: "speaker",
      suggested_matches: ["Dr. Matt", "Dr. Ben"]
    }
  });

  await insertClaimCandidate({
    namespaceId,
    occurredAt: "2026-03-29T02:12:00.000Z",
    claimType: "relationship",
    predicate: "currently_in",
    subjectText: "Steve Tietze",
    subjectEntityType: "self",
    subjectEntityId: selfId,
    objectText: "the summer cabin",
    objectEntityType: "place",
    ambiguityType: "place_grounding",
    ambiguityReason: 'The object reference "the summer cabin" still needs a concrete place.'
  });

  await insertClaimCandidate({
    namespaceId,
    occurredAt: "2026-03-29T02:13:00.000Z",
    claimType: "relationship",
    predicate: "works_with",
    subjectText: "Alex",
    subjectEntityType: "person",
    objectText: "Steve Tietze",
    objectEntityType: "self",
    objectEntityId: selfId,
    ambiguityType: "alias_collision",
    ambiguityReason: 'The subject reference "Alex" matches multiple possible people.',
    metadata: {
      suggested_matches: ["Alex Morgan", "Alex Chen"]
    }
  });

  await insertClaimCandidate({
    namespaceId,
    occurredAt: "2026-03-29T02:14:00.000Z",
    claimType: "relationship",
    predicate: "located_in",
    subjectText: "Kozimui",
    subjectEntityType: "place",
    objectText: "Thailand",
    objectEntityType: "place",
    objectEntityId: thailandId,
    ambiguityType: "asr_correction",
    ambiguityReason: 'The place reference "Kozimui" may be an ASR drift or misspelling.',
    metadata: {
      suggested_matches: ["Koh Samui", "Samui"]
    }
  });
}

async function rebuildNamespaceState(namespaceId: string): Promise<void> {
  await rebuildTypedMemoryNamespace(namespaceId);
  await refreshRelationshipPriors(namespaceId);
  await runCandidateConsolidation(namespaceId);
  await runRelationshipAdjudication(namespaceId);
  await runTemporalSummaryScaffold(namespaceId, {
    layer: "day"
  });
}

async function loadClarificationItems(namespaceId: string, query?: string): Promise<any> {
  return unwrapStructured(
    await executeMcpTool("memory.get_clarifications", {
      namespace_id: namespaceId,
      ...(query ? { query } : {}),
      limit: 12
    })
  );
}

async function loadGraph(namespaceId: string, entityName: string): Promise<any> {
  return unwrapStructured(
    await executeMcpTool("memory.get_graph", {
      namespace_id: namespaceId,
      entity_name: entityName,
      limit: 24
    })
  );
}

async function loadSearch(namespaceId: string, query: string): Promise<any> {
  return unwrapStructured(
    await executeMcpTool("memory.search", {
      namespace_id: namespaceId,
      query,
      limit: 8
    })
  );
}

async function resolveRawText(
  namespaceId: string,
  rawText: string,
  canonicalName: string,
  entityType: string,
  aliases: readonly string[]
): Promise<void> {
  const inbox = await getClarificationInbox(namespaceId, 20);
  const item = inbox.items.find((candidate) => candidate.rawText.toLowerCase() === rawText.toLowerCase());
  if (!item) {
    throw new Error(`Missing clarification item for ${rawText}.`);
  }

  await resolveClarification({
    namespaceId,
    candidateId: item.candidateId,
    canonicalName,
    entityType,
    targetRole: item.targetRole,
    aliases,
    note: "Benchmark clarification resolution."
  });
}

function buildScenario(name: string, phase: ScenarioResult["phase"], failures: readonly string[], note?: string): ScenarioResult {
  return {
    name,
    phase,
    passed: failures.length === 0,
    failures,
    ...(note ? { note } : {})
  };
}

function graphNodeNames(payload: any): string[] {
  const graph = payload?.graph ?? payload;
  return Array.isArray(graph?.nodes) ? graph.nodes.map((node: any) => String(node?.name ?? "")) : [];
}

function graphPayload(payload: any): any {
  return payload?.graph ?? payload;
}

async function runScenarioSuite(
  namespaceId: string,
  phase: ScenarioResult["phase"],
  options: { readonly applyReplayClosure?: boolean } = {}
): Promise<readonly ScenarioResult[]> {
  if (options.applyReplayClosure === true) {
    await rebuildTypedMemoryNamespace(namespaceId);
    await applyStoredClarificationResolutions(namespaceId);
    await rebuildNamespaceState(namespaceId);
  }

  const results: ScenarioResult[] = [];

  if (phase === "unresolved") {
    const uncleSearch = await loadSearch(namespaceId, "Who is Uncle?");
    const doctorSearch = await loadSearch(namespaceId, "Who is the doctor?");
    const cabinSearch = await loadSearch(namespaceId, "Where was the summer cabin?");
    const alexSearch = await loadSearch(namespaceId, "Who is Alex in my life?");
    const kozimuiSearch = await loadSearch(namespaceId, "Did you mean Koh Samui when the note said Kozimui?");
    const clarifications = await loadClarificationItems(namespaceId);
    const alexGraph = await loadGraph(namespaceId, "Alex");

    results.push(
      buildScenario(
        "uncle_query_routes_to_clarification",
        "unresolved",
        [
          ...(uncleSearch?.meta?.followUpAction === "route_to_clarifications" ? [] : [`expected route_to_clarifications, got ${uncleSearch?.meta?.followUpAction ?? "n/a"}`]),
          ...(hasTerm(uncleSearch, "clarification") ? [] : ["search payload did not mention clarification for Uncle"])
        ]
      )
    );
    results.push(
      buildScenario(
        "doctor_query_routes_to_clarification",
        "unresolved",
        [
          ...(doctorSearch?.meta?.followUpAction === "route_to_clarifications" ? [] : [`expected route_to_clarifications, got ${doctorSearch?.meta?.followUpAction ?? "n/a"}`])
        ]
      )
    );
    results.push(
      buildScenario(
        "summer_cabin_query_routes_to_clarification",
        "unresolved",
        [
          ...(cabinSearch?.meta?.followUpAction === "route_to_clarifications" ? [] : [`expected route_to_clarifications, got ${cabinSearch?.meta?.followUpAction ?? "n/a"}`])
        ]
      )
    );
    results.push(
      buildScenario(
        "alex_query_routes_to_clarification",
        "unresolved",
        [
          ...(alexSearch?.meta?.followUpAction === "route_to_clarifications" ? [] : [`expected route_to_clarifications, got ${alexSearch?.meta?.followUpAction ?? "n/a"}`])
        ]
      )
    );
    results.push(
      buildScenario(
        "kozimui_query_routes_to_clarification",
        "unresolved",
        [
          ...(kozimuiSearch?.meta?.followUpAction === "route_to_clarifications" ? [] : [`expected route_to_clarifications, got ${kozimuiSearch?.meta?.followUpAction ?? "n/a"}`])
        ]
      )
    );
    results.push(
      buildScenario(
        "clarification_inbox_has_expected_pressure",
        "unresolved",
        [
          ...(Number(clarifications?.summary?.total ?? 0) >= 5 ? [] : [`expected at least 5 open clarifications, got ${clarifications?.summary?.total ?? 0}`])
        ]
      )
    );
    results.push(
      buildScenario(
        "alex_graph_surfaces_ambiguity",
        "unresolved",
        [
          ...(graphPayload(alexGraph)?.ambiguityState === "ambiguous"
            ? []
            : [`expected graph ambiguityState ambiguous, got ${graphPayload(alexGraph)?.ambiguityState ?? "n/a"}`]),
          ...(Number(graphPayload(alexGraph)?.clarificationCount ?? 0) > 0 ? [] : ["expected graph clarificationCount to be > 0"]),
          ...((graphPayload(alexGraph)?.suggestedMatches ?? []).length > 0 ? [] : ["expected graph suggestedMatches for ambiguous Alex"])
        ]
      )
    );

    return results;
  }

  const uncleClarifications = await loadClarificationItems(namespaceId, "uncle");
  const kozimuiClarifications = await loadClarificationItems(namespaceId, "kozimui");
  const alexClarifications = await loadClarificationItems(namespaceId, "alex");
  const uncleGraph = await loadGraph(namespaceId, "Uncle");
  const kozimuiGraph = await loadGraph(namespaceId, "Kozimui");
  const alexGraph = await loadGraph(namespaceId, "Alex");
  const replayNote = phase === "replay" ? "replayed" : "live";

  results.push(
    buildScenario(
      `uncle_clarification_closed_${replayNote}`,
      phase,
      [
        ...(Number(uncleClarifications?.items?.length ?? 0) === 0 ? [] : [`expected no uncle clarifications, found ${uncleClarifications?.items?.length ?? 0}`]),
        ...(hasTerm(uncleClarifications, "no open clarification items matched") ? [] : ["expected clean clarification guidance for Uncle"])
      ]
    )
  );
  results.push(
    buildScenario(
      `kozimui_clarification_closed_${replayNote}`,
      phase,
      [
        ...(Number(kozimuiClarifications?.items?.length ?? 0) === 0 ? [] : [`expected no kozimui clarifications, found ${kozimuiClarifications?.items?.length ?? 0}`])
      ]
    )
  );
  results.push(
    buildScenario(
      `uncle_graph_collapses_${replayNote}`,
      phase,
      [
        ...(hasTerm(uncleGraph, "billy smith") ? [] : ["graph did not resolve Uncle to Billy Smith"]),
        ...(graphNodeNames(uncleGraph).some((name) => name.toLowerCase() === "uncle") ? ["split Uncle node survived in graph"] : []),
        ...(Array.isArray(graphPayload(uncleGraph)?.nodes) && graphPayload(uncleGraph).nodes.length > 0 ? [] : ["resolved Uncle graph returned no nodes"])
      ]
    )
  );
  results.push(
    buildScenario(
      `kozimui_graph_collapses_${replayNote}`,
      phase,
      [
        ...(hasTerm(kozimuiGraph, "koh samui") ? [] : ["graph did not resolve Kozimui to Koh Samui"]),
        ...(graphNodeNames(kozimuiGraph).some((name) => name.toLowerCase() === "kozimui") ? ["split Kozimui node survived in graph"] : [])
      ]
    )
  );
  results.push(
    buildScenario(
      `alex_remains_ambiguous_${replayNote}`,
      phase,
      [
        ...(Number(alexClarifications?.items?.length ?? 0) > 0 ? [] : ["expected Alex clarification pressure to remain unresolved"]),
        ...(graphPayload(alexGraph)?.ambiguityState === "ambiguous"
          ? []
          : [`expected Alex graph ambiguityState ambiguous, got ${graphPayload(alexGraph)?.ambiguityState ?? "n/a"}`])
      ]
    )
  );

  return results;
}

function toMarkdown(report: ClarificationTruthReviewReport): string {
  const lines = [
    "# Clarification Truth Review",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- namespaceId: ${report.namespaceId}`,
    `- fixtureRoot: ${report.fixtureRoot}`,
    `- pass/fail: ${report.summary.pass}/${report.summary.fail}`,
    "",
    "## Scenarios",
    ""
  ];

  for (const scenario of report.scenarios) {
    lines.push(`- [${scenario.phase}] ${scenario.name}: ${scenario.passed ? "pass" : "fail"}`);
    if (scenario.note) {
      lines.push(`  - note: ${scenario.note}`);
    }
    for (const failure of scenario.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteClarificationTruthReviewBenchmark(
  namespaceId = `benchmark_clarification_truth_${new Date().toISOString().replace(/[:.]/g, "-")}`
): Promise<{
  readonly report: ClarificationTruthReviewReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  return withMaintenanceLock("the clarification truth benchmark", async () => {
    await runMigrations();
    const { rootPath, files } = await writeFixtures(namespaceId);

    await ingestFixtures(namespaceId, rootPath, files);
    await seedAmbiguousClaims(namespaceId);
    const unresolvedResults = await runScenarioSuite(namespaceId, "unresolved");

    await resolveRawText(namespaceId, "Uncle", "Billy Smith", "person", ["Joe Bob", "Uncle"]);
    await resolveRawText(namespaceId, "Kozimui", "Koh Samui", "place", ["Samui", "Koh Samui"]);
    await processBrainOutboxEvents({
      namespaceId,
      limit: 25
    });
    const resolvedResults = await runScenarioSuite(namespaceId, "resolved");

    await resetNamespaceData(namespaceId);
    await closePool();
    await ingestFixtures(namespaceId, rootPath, files);
    await seedAmbiguousClaims(namespaceId);
    const replayResults = await runScenarioSuite(namespaceId, "replay", {
      applyReplayClosure: true
    });

    const scenarios = [...unresolvedResults, ...resolvedResults, ...replayResults];
    const report: ClarificationTruthReviewReport = {
      generatedAt: new Date().toISOString(),
      namespaceId,
      fixtureRoot: rootPath,
      scenarios,
      summary: {
        pass: scenarios.filter((scenario) => scenario.passed).length,
        fail: scenarios.filter((scenario) => !scenario.passed).length
      }
    };

    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const jsonPath = path.join(dir, `clarification-truth-review-${stamp}.json`);
    const markdownPath = path.join(dir, `clarification-truth-review-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  });
}

export async function runClarificationTruthReviewBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteClarificationTruthReviewBenchmark();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closePool();
  }
}
