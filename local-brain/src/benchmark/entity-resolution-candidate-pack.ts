import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEntityResolutionCandidateSet, type EntityResolutionCandidateInput } from "../identity/entity-resolution-candidate-set.js";

interface Scenario {
  readonly id: string;
  readonly observedName: string;
  readonly expectedEntityType: string;
  readonly relationshipNeighbors?: readonly string[];
  readonly places?: readonly string[];
  readonly sourceUris?: readonly string[];
  readonly occurredAt?: string;
  readonly candidates: readonly EntityResolutionCandidateInput[];
  readonly expectedDecision: string;
  readonly expectedSelectedEntityId?: string | null;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "single_gummi_alias",
    observedName: "Omni Gummi",
    expectedEntityType: "person",
    relationshipNeighbors: ["Dan", "Tim", "Ben"],
    places: ["Chiang Mai"],
    sourceUris: ["omi://chiang-mai-friends"],
    occurredAt: "2026-05-18T00:00:00Z",
    expectedDecision: "prompt_merge",
    expectedSelectedEntityId: null,
    candidates: [
      {
        entityId: "person:gummi",
        canonicalName: "Gummi",
        entityType: "person",
        aliases: ["Omni Gummi", "Gumi"],
        relationshipNeighbors: ["Dan", "Tim", "Ben"],
        places: ["Chiang Mai"],
        sourceUris: ["omi://chiang-mai-friends"],
        activeFrom: "2024-01-01"
      }
    ]
  },
  {
    id: "ambiguous_same_name",
    observedName: "Stephen",
    expectedEntityType: "person",
    relationshipNeighbors: ["Lauren"],
    places: ["Thailand"],
    expectedDecision: "prompt_choose",
    candidates: [
      { entityId: "person:stephen-a", canonicalName: "Stephen", entityType: "person", relationshipNeighbors: ["Lauren"], places: ["Thailand"] },
      { entityId: "person:stephen-b", canonicalName: "Steven", entityType: "person", aliases: ["Stephen"], relationshipNeighbors: ["Lauren"], places: ["Thailand"] }
    ]
  },
  {
    id: "nickname_transliteration_single_candidate",
    observedName: "Gumi",
    expectedEntityType: "person",
    relationshipNeighbors: ["Dan", "Ben"],
    places: ["Chiang Mai"],
    expectedDecision: "prompt_merge",
    expectedSelectedEntityId: null,
    candidates: [
      { entityId: "person:gummi", canonicalName: "Gummi", entityType: "person", aliases: ["Gumi"], relationshipNeighbors: ["Dan", "Ben"], places: ["Chiang Mai"] },
      { entityId: "project:gumi-tool", canonicalName: "Gumi", entityType: "project", aliases: ["Gumi"] }
    ]
  },
  {
    id: "no_candidate_prompt_create",
    observedName: "Morgan",
    expectedEntityType: "person",
    relationshipNeighbors: ["Dan"],
    places: ["Chiang Mai"],
    expectedDecision: "create_new",
    candidates: [
      { entityId: "person:gummi", canonicalName: "Gummi", entityType: "person", relationshipNeighbors: ["Dan"], places: ["Chiang Mai"] }
    ]
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export async function runAndWriteEntityResolutionCandidatePack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = SCENARIOS.map((scenario) => {
    const result = buildEntityResolutionCandidateSet(
      {
        observedName: scenario.observedName,
        expectedEntityType: scenario.expectedEntityType,
        relationshipNeighbors: scenario.relationshipNeighbors,
        places: scenario.places,
        sourceUris: scenario.sourceUris,
        occurredAt: scenario.occurredAt
      },
      scenario.candidates
    );
    const passed =
      result.decision === scenario.expectedDecision &&
      (scenario.expectedSelectedEntityId === undefined || result.selectedEntityId === scenario.expectedSelectedEntityId) &&
      result.ambiguousMergeSilentAccept === false;
    return { ...scenario, result, passed };
  });
  const metrics = {
    duplicateEntityFalseMergeCount: rows.filter((row) => row.id === "ambiguous_same_name" && row.result.selectedEntityId !== null).length,
    ambiguousMergeSilentAcceptCount: rows.filter((row) => row.result.ambiguousMergeSilentAccept).length,
    sameNameDisambiguationPassRate: Number((rows.filter((row) => row.passed).length / rows.length).toFixed(4)),
    promptContractCoverageRate: Number((rows.filter((row) => row.result.promptKind !== "none" || row.result.decision === "auto_attach").length / rows.length).toFixed(4))
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "entity_resolution_candidate_pack",
    passed:
      rows.every((row) => row.passed) &&
      metrics.duplicateEntityFalseMergeCount === 0 &&
      metrics.ambiguousMergeSilentAcceptCount === 0 &&
      metrics.sameNameDisambiguationPassRate >= 0.95,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `entity-resolution-candidate-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `entity-resolution-candidate-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Entity Resolution Candidate Pack\n\n- passed: ${report.passed}\n- duplicateEntityFalseMergeCount: ${metrics.duplicateEntityFalseMergeCount}\n- ambiguousMergeSilentAcceptCount: ${metrics.ambiguousMergeSilentAcceptCount}\n- sameNameDisambiguationPassRate: ${metrics.sameNameDisambiguationPassRate}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runEntityResolutionCandidatePackCli(): Promise<void> {
  const { report, output } = await runAndWriteEntityResolutionCandidatePack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
