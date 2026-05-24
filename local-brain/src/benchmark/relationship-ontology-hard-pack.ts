import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelationshipSupportBundle, type RelationshipOntologyPredicate } from "../retrieval/relationship-support-bundle.js";

const BASE = [
  ["Who are my friends in Chiang Mai?", "friend_of"],
  ["Who did Dan introduce me to in Chiang Mai?", "introduced_by"],
  ["Where did I meet Gummi?", "met_at"],
  ["Who did I meet through Dan?", "met_through"],
  ["Who did I work with at id Software?", "worked_with"],
  ["Who is in my Chiang Mai coworking group?", "social_group_member"],
  ["List mutual friends with Dan", "friend_of"],
  ["Did Ben meet me through Dan?", "met_through"],
  ["What friends did I know from coworking?", "worked_with"],
  ["Who is part of the local friend group?", "social_group_member"]
] as const;

const SCENARIOS = Array.from({ length: 50 }, (_, index) => {
  const [query, predicate] = BASE[index % BASE.length]!;
  return {
    id: `relationship_ontology_${String(index + 1).padStart(2, "0")}`,
    query: `${query}${index >= BASE.length ? ` variant ${Math.floor(index / BASE.length)}` : ""}`,
    expectedPredicate: predicate as RelationshipOntologyPredicate
  };
});

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export async function runAndWriteRelationshipOntologyHardPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = SCENARIOS.map((scenario) => {
    const bundle = buildRelationshipSupportBundle({
      subject: "Steve Tietze",
      object: scenario.query.includes("Dan") ? "Dan" : null,
      text: scenario.query,
      places: scenario.query.includes("Chiang Mai") ? ["Chiang Mai"] : [],
      sourceTrailCount: 1
    });
    const placeScoped = scenario.query.includes("Chiang Mai");
    const passed = bundle.predicate === scenario.expectedPredicate && (!placeScoped || bundle.place === "Chiang Mai") && bundle.sourceTrailCount > 0;
    return { ...scenario, bundle, passed };
  });
  const predicateMatches = rows.filter((row) => row.bundle.predicate === row.expectedPredicate).length;
  const placeScopedRows = rows.filter((row) => row.query.includes("Chiang Mai"));
  const metrics = {
    relationshipPredicateAccuracy: Number((predicateMatches / rows.length).toFixed(4)),
    placeScopedRelationshipAccuracy: Number((placeScopedRows.filter((row) => row.bundle.place === "Chiang Mai").length / Math.max(placeScopedRows.length, 1)).toFixed(4)),
    supportBundleSourceTrailCoverageRate: Number((rows.filter((row) => row.bundle.sourceTrailCount > 0).length / rows.length).toFixed(4))
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "relationship_ontology_hard_pack",
    sampleCount: rows.length,
    passed: rows.every((row) => row.passed) && metrics.relationshipPredicateAccuracy >= 0.95 && metrics.placeScopedRelationshipAccuracy >= 0.95,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `relationship-ontology-hard-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `relationship-ontology-hard-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Relationship Ontology Hard Pack\n\n- passed: ${report.passed}\n- relationshipPredicateAccuracy: ${metrics.relationshipPredicateAccuracy}\n- placeScopedRelationshipAccuracy: ${metrics.placeScopedRelationshipAccuracy}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRelationshipOntologyHardPackCli(): Promise<void> {
  const { report, output } = await runAndWriteRelationshipOntologyHardPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
