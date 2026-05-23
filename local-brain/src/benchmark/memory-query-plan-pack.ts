import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMemoryQueryPlan } from "../retrieval/memory-query-plan.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly expectedIntent: string;
  readonly expectedContract: string;
  readonly expectedSubjects?: readonly string[];
  readonly expectedPlaces?: readonly string[];
  readonly expectedProjects?: readonly string[];
  readonly expectedSourceScope?: string;
  readonly expectedTaskScope?: string;
}

interface Row extends Scenario {
  readonly actualIntent: string;
  readonly actualContract: string;
  readonly actualSubjects: readonly string[];
  readonly actualPlaces: readonly string[];
  readonly actualProjects: readonly string[];
  readonly actualSourceScope: string;
  readonly actualTaskScope: string;
  readonly wrongSubjectBinding: boolean;
  readonly wrongPlaceBinding: boolean;
  readonly wrongContract: boolean;
  readonly passed: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "friends_place_scope",
    query: "Who are my friends in Chiang Mai?",
    expectedIntent: "relationship_friend_set",
    expectedContract: "shared_social_graph",
    expectedSubjects: ["Steve Tietze"],
    expectedPlaces: ["Chiang Mai"]
  },
  {
    id: "introduced_place_scope",
    query: "Which friends did Dan introduce me to in Chiang Mai, and where did I meet them?",
    expectedIntent: "relationship_friend_set",
    expectedContract: "shared_social_graph",
    expectedSubjects: ["Steve Tietze", "Dan"],
    expectedPlaces: ["Chiang Mai"]
  },
  {
    id: "multi_entity_synthesis",
    query: "What do I know about Gummi, Two Way, and the Istanbul trip?",
    expectedIntent: "multi_entity_synthesis",
    expectedContract: "direct_fact",
    expectedSubjects: ["Steve Tietze", "Gummi"],
    expectedPlaces: ["Istanbul"],
    expectedProjects: ["Two Way"]
  },
  {
    id: "latest_note_tasks",
    query: "What tasks did I mention in my most recent OMI note?",
    expectedIntent: "task_list",
    expectedContract: "task_list",
    expectedSourceScope: "latest_omi_note",
    expectedTaskScope: "latest_source"
  },
  {
    id: "source_audit_friend_set",
    query: "Show the sources for my Chiang Mai friends answer: Dan, Gummi, Tim, and Ben.",
    expectedIntent: "source_audit",
    expectedContract: "source_audit",
    expectedSubjects: ["Steve Tietze", "Dan", "Gummi", "Tim", "Ben"],
    expectedPlaces: ["Chiang Mai"]
  },
  {
    id: "temporal_change",
    query: "What changed about my July and September travel plans?",
    expectedIntent: "temporal_change",
    expectedContract: "temporal_event"
  }
];

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function hasAll(actual: readonly string[], expected: readonly string[] = []): boolean {
  const actualKeys = new Set(actual.map((item) => item.toLowerCase()));
  return expected.every((item) => actualKeys.has(item.toLowerCase()));
}

function runRow(scenario: Scenario): Row {
  const contract = inferQueryContract(scenario.query);
  const plan = buildMemoryQueryPlan(scenario.query, contract);
  const wrongSubjectBinding = !hasAll(plan.subjects, scenario.expectedSubjects);
  const wrongPlaceBinding = !hasAll(plan.places, scenario.expectedPlaces);
  const wrongContract = plan.queryContract !== scenario.expectedContract || plan.intent !== scenario.expectedIntent;
  const wrongProjectBinding = !hasAll(plan.projects, scenario.expectedProjects);
  const wrongSourceScope = scenario.expectedSourceScope ? plan.sourceScope !== scenario.expectedSourceScope : false;
  const wrongTaskScope = scenario.expectedTaskScope ? plan.taskScope !== scenario.expectedTaskScope : false;
  return {
    ...scenario,
    actualIntent: plan.intent,
    actualContract: plan.queryContract,
    actualSubjects: plan.subjects,
    actualPlaces: plan.places,
    actualProjects: plan.projects,
    actualSourceScope: plan.sourceScope,
    actualTaskScope: plan.taskScope,
    wrongSubjectBinding,
    wrongPlaceBinding,
    wrongContract,
    passed: !wrongSubjectBinding && !wrongPlaceBinding && !wrongContract && !wrongProjectBinding && !wrongSourceScope && !wrongTaskScope
  };
}

export async function runAndWriteMemoryQueryPlanPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = SCENARIOS.map(runRow);
  const generatedAt = new Date().toISOString();
  const metrics = {
    wrongSubjectBindingCount: rows.filter((row) => row.wrongSubjectBinding).length,
    wrongPlaceBindingCount: rows.filter((row) => row.wrongPlaceBinding).length,
    wrongContractCount: rows.filter((row) => row.wrongContract).length
  };
  const report = {
    generatedAt,
    benchmark: "memory_query_plan_pack",
    sampleCount: rows.length,
    passed: rows.every((row) => row.passed) && metrics.wrongSubjectBindingCount === 0 && metrics.wrongPlaceBindingCount === 0 && metrics.wrongContractCount === 0,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `memory-query-plan-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `memory-query-plan-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Memory Query Plan Pack\n\n- passed: ${report.passed}\n- wrongSubjectBindingCount: ${metrics.wrongSubjectBindingCount}\n- wrongPlaceBindingCount: ${metrics.wrongPlaceBindingCount}\n- wrongContractCount: ${metrics.wrongContractCount}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMemoryQueryPlanPackCli(): Promise<void> {
  const { report, output } = await runAndWriteMemoryQueryPlanPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
