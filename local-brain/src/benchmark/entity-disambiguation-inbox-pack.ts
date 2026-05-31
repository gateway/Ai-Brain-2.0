import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { areEntityRolesCompatible } from "../identity/entity-role-resolution.js";
import { buildEntityResolutionCandidateSet, type EntityResolutionCandidateInput } from "../identity/entity-resolution-candidate-set.js";
import { runAndWriteEntityResolutionCandidatePack } from "./entity-resolution-candidate-pack.js";
import { runAndWriteMcpCorrectionPropagationPack } from "./mcp-correction-propagation-pack.js";

type InboxCandidateType =
  | "alias_merge_candidate"
  | "keep_separate_candidate"
  | "role_conflict_candidate"
  | "project_alias_candidate"
  | "place_alias_candidate"
  | "source_spelling_candidate";

interface Scenario {
  readonly id: string;
  readonly candidateType: InboxCandidateType;
  readonly observedName: string;
  readonly expectedEntityType: string;
  readonly relationshipNeighbors?: readonly string[];
  readonly places?: readonly string[];
  readonly sourceUris?: readonly string[];
  readonly candidates: readonly EntityResolutionCandidateInput[];
  readonly expectedDecision: string;
  readonly expectedSelectedEntityId?: string | null;
  readonly roleCompatibility?: {
    readonly roles: readonly ("person" | "place" | "project" | "org" | "venue")[];
    readonly expectedCompatible: boolean;
  };
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "gummi_alias_requires_merge_prompt",
    candidateType: "alias_merge_candidate",
    observedName: "Omi Gummi",
    expectedEntityType: "person",
    relationshipNeighbors: ["Dan", "Tim", "Ben"],
    places: ["Chiang Mai"],
    sourceUris: ["omi://chiang-mai-friends"],
    expectedDecision: "prompt_merge",
    expectedSelectedEntityId: null,
    candidates: [
      {
        entityId: "person:gummi",
        canonicalName: "Gummi",
        entityType: "person",
        aliases: ["Gumi", "Omi Gummi"],
        relationshipNeighbors: ["Dan", "Tim", "Ben"],
        places: ["Chiang Mai"],
        sourceUris: ["omi://chiang-mai-friends"]
      }
    ]
  },
  {
    id: "same_first_name_requires_choice",
    candidateType: "keep_separate_candidate",
    observedName: "Stephen",
    expectedEntityType: "person",
    relationshipNeighbors: ["Lauren"],
    places: ["Thailand"],
    expectedDecision: "prompt_choose",
    candidates: [
      { entityId: "person:stephen-a", canonicalName: "Stephen", entityType: "person", relationshipNeighbors: ["Lauren"], places: ["Thailand"] },
      { entityId: "person:steven-b", canonicalName: "Steven", entityType: "person", aliases: ["Stephen"], relationshipNeighbors: ["Lauren"], places: ["Thailand"] }
    ]
  },
  {
    id: "chiang_mai_place_not_person",
    candidateType: "place_alias_candidate",
    observedName: "Chiang Mai",
    expectedEntityType: "place",
    expectedDecision: "prompt_merge",
    expectedSelectedEntityId: null,
    roleCompatibility: { roles: ["person", "place"], expectedCompatible: false },
    candidates: [
      { entityId: "place:chiang-mai", canonicalName: "Chiang Mai", entityType: "place", aliases: ["CM", "Chiangmai"] },
      { entityId: "person:chiang-mai", canonicalName: "Chiang Mai", entityType: "person" }
    ]
  },
  {
    id: "two_way_project_org_allowed",
    candidateType: "project_alias_candidate",
    observedName: "Two Way",
    expectedEntityType: "project",
    expectedDecision: "prompt_merge",
    roleCompatibility: { roles: ["project", "org"], expectedCompatible: true },
    candidates: [
      { entityId: "project:two-way", canonicalName: "Two-Way", entityType: "project", aliases: ["Two Way", "2Way"] },
      { entityId: "org:two-way", canonicalName: "Two-Way", entityType: "org", aliases: ["Two Way", "2Way"] }
    ]
  },
  {
    id: "spelling_correction_requires_merge_prompt",
    candidateType: "source_spelling_candidate",
    observedName: "Gumee",
    expectedEntityType: "person",
    relationshipNeighbors: ["Dan"],
    places: ["Chiang Mai"],
    expectedDecision: "prompt_merge",
    expectedSelectedEntityId: null,
    candidates: [
      { entityId: "person:gummi", canonicalName: "Gummi", entityType: "person", aliases: ["Gumi", "Gumee"], relationshipNeighbors: ["Dan"], places: ["Chiang Mai"] }
    ]
  },
  {
    id: "role_conflict_requires_review",
    candidateType: "role_conflict_candidate",
    observedName: "Preset Kitchen",
    expectedEntityType: "project",
    expectedDecision: "prompt_merge",
    roleCompatibility: { roles: ["person", "project"], expectedCompatible: false },
    candidates: [
      { entityId: "project:preset-kitchen", canonicalName: "Preset Kitchen", entityType: "project", aliases: ["PresetKitchen"] },
      { entityId: "person:preset-kitchen", canonicalName: "Preset Kitchen", entityType: "person" }
    ]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function scenarioRows(): readonly Record<string, unknown>[] {
  return SCENARIOS.map((scenario) => {
    const result = buildEntityResolutionCandidateSet(
      {
        observedName: scenario.observedName,
        expectedEntityType: scenario.expectedEntityType,
        relationshipNeighbors: scenario.relationshipNeighbors,
        places: scenario.places,
        sourceUris: scenario.sourceUris
      },
      scenario.candidates
    );
    const roleCompatible =
      scenario.roleCompatibility === undefined ? null : areEntityRolesCompatible(scenario.roleCompatibility.roles);
    const passed =
      result.decision === scenario.expectedDecision &&
      (scenario.expectedSelectedEntityId === undefined || result.selectedEntityId === scenario.expectedSelectedEntityId) &&
      result.ambiguousMergeSilentAccept === false &&
      (scenario.roleCompatibility === undefined || roleCompatible === scenario.roleCompatibility.expectedCompatible);
    return {
      id: scenario.id,
      candidateType: scenario.candidateType,
      observedName: scenario.observedName,
      expectedDecision: scenario.expectedDecision,
      actualDecision: result.decision,
      selectedEntityId: result.selectedEntityId,
      promptRequired: result.promptRequired,
      promptKind: result.promptKind,
      ambiguousMergeSilentAccept: result.ambiguousMergeSilentAccept,
      roleCompatible,
      passed
    };
  });
}

function toMarkdown(report: any): string {
  return [
    "# Entity Disambiguation Inbox Pack",
    "",
    `- passed: ${report.passed}`,
    `- candidateTypeCoverageRate: ${report.metrics.candidateTypeCoverageRate}`,
    `- falseMergePreventionRate: ${report.metrics.falseMergePreventionRate}`,
    `- wrongRolePromotionCount: ${report.metrics.wrongRolePromotionCount}`,
    `- replaySurvivalRate: ${report.metrics.replaySurvivalRate}`,
    `- orphanReferenceCount: ${report.metrics.orphanReferenceCount}`,
    "",
    "## Rows",
    "",
    ...report.rows.map((row: any) => `- ${row.id}: passed=${row.passed} type=${row.candidateType} decision=${row.actualDecision}`)
  ].join("\n") + "\n";
}

export async function runAndWriteEntityDisambiguationInboxPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const [candidatePack, correctionPack] = await Promise.all([
    runAndWriteEntityResolutionCandidatePack(),
    runAndWriteMcpCorrectionPropagationPack()
  ]);
  const rows = scenarioRows();
  const candidateTypes = new Set(rows.map((row: any) => row.candidateType));
  const metrics = {
    candidateTypeCoverageRate: Number((candidateTypes.size / 6).toFixed(4)),
    promptCoverageRate: Number((rows.filter((row: any) => row.promptRequired === true || row.actualDecision === "auto_attach").length / rows.length).toFixed(4)),
    falseMergePreventionRate: Number((rows.filter((row: any) => row.ambiguousMergeSilentAccept === false).length / rows.length).toFixed(4)),
    wrongRolePromotionCount: rows.filter((row: any) => row.roleCompatible === false && row.selectedEntityId !== null && row.actualDecision === "auto_attach").length,
    candidatePackPassed: candidatePack.report.passed === true ? 1 : 0,
    correctionPropagationPassed: correctionPack.report.passed === true ? 1 : 0,
    replaySurvivalRate: correctionPack.report.metrics?.replayableCorrectionArtifactCoverageRate ?? 0,
    hardClassConstraintCoverageRate: correctionPack.report.metrics?.hardClassConstraintCoverageRate ?? 0,
    orphanReferenceCount: correctionPack.report.metrics?.orphanReferenceAuditPassRate === 1 ? 0 : 1,
    rawEvidenceDeletedCount: correctionPack.report.metrics?.rawEvidenceDeletedCount ?? 0,
    queryTimeModelCalls: correctionPack.report.metrics?.queryTimeModelCalls ?? 0
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "entity_disambiguation_inbox_pack",
    passed:
      rows.every((row: any) => row.passed === true) &&
      metrics.candidateTypeCoverageRate === 1 &&
      metrics.falseMergePreventionRate === 1 &&
      metrics.wrongRolePromotionCount === 0 &&
      metrics.candidatePackPassed === 1 &&
      metrics.correctionPropagationPassed === 1 &&
      metrics.replaySurvivalRate === 1 &&
      metrics.hardClassConstraintCoverageRate === 1 &&
      metrics.orphanReferenceCount === 0 &&
      metrics.rawEvidenceDeletedCount === 0 &&
      metrics.queryTimeModelCalls === 0,
    metrics,
    dependencyArtifacts: {
      entityResolutionCandidatePack: candidatePack.output.jsonPath,
      mcpCorrectionPropagationPack: correctionPack.output.jsonPath
    },
    rows
  };
  await mkdir(outputDir(), { recursive: true });
  const suffix = stamp();
  const jsonPath = path.join(outputDir(), `entity-disambiguation-inbox-pack-${suffix}.json`);
  const markdownPath = path.join(outputDir(), `entity-disambiguation-inbox-pack-${suffix}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runEntityDisambiguationInboxPackCli(): Promise<void> {
  const { report, output } = await runAndWriteEntityDisambiguationInboxPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
