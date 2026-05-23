import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMemoryQueryPlan } from "../retrieval/memory-query-plan.js";
import { inferQueryContract } from "../retrieval/query-contract-router.js";

const QUERY_TEMPLATES = [
  ["What did my latest OMI note say about travel?", "temporal_event", "temporal_events"],
  ["What tasks did I mention in the latest OMI note?", "task_list", "task_items"],
  ["What does the hybrid temporal memory retrieval spec say?", "document_spec", "repo_docs"],
  ["How do I run the MCP query taxonomy gold benchmark?", "procedure_command", "package_scripts"],
  ["Who are my friends in Chiang Mai?", "relationship_friend_set", "relationship_graph"],
  ["Who did Dan introduce me to in Chiang Mai?", "relationship_friend_set", "relationship_graph"],
  ["What open tasks remain from the source audit work?", "project_task_scope", "task_items"],
  ["Give me my short work history with roles and dates.", "career_history", "career_projection"],
  ["What changed about my July and September travel plans?", "temporal_change", "temporal_events"],
  ["Show the sources for my Chiang Mai friends answer.", "source_audit", "source_topic_report"]
] as const;

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

export async function runAndWriteMixedSourceHumanQueryAuditPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const [query, expectedIntent, expectedCorpus] = QUERY_TEMPLATES[index % QUERY_TEMPLATES.length]!;
    const variant = index < QUERY_TEMPLATES.length ? query : `${query} Please keep it compact and source-backed.`;
    const contract = inferQueryContract(variant);
    const plan = buildMemoryQueryPlan(variant, contract);
    const passed = plan.intent === expectedIntent && plan.selectedCorpusCapability === expectedCorpus && plan.queryContract !== "review_only";
    return {
      id: `mixed_source_${String(index + 1).padStart(3, "0")}`,
      query: variant,
      expectedIntent,
      selectedIntent: plan.intent,
      expectedCorpus,
      selectedCorpus: plan.selectedCorpusCapability,
      wrongRoute: plan.intent !== expectedIntent,
      wrongCorpus: plan.selectedCorpusCapability !== expectedCorpus,
      passed
    };
  });
  const metrics = {
    sampleCount: rows.length,
    wrongRouteCount: rows.filter((row) => row.wrongRoute).length,
    wrongCorpusCount: rows.filter((row) => row.wrongCorpus).length,
    mixedSourcePlannerPassRate: Number((rows.filter((row) => row.passed).length / rows.length).toFixed(4))
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "mixed_source_human_query_audit_pack",
    passed: metrics.wrongRouteCount === 0 && metrics.wrongCorpusCount === 0 && metrics.mixedSourcePlannerPassRate >= 0.97,
    metrics,
    results: rows
  };
  await mkdir(outputDir(), { recursive: true });
  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outputDir(), `mixed-source-human-query-audit-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `mixed-source-human-query-audit-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `# Mixed Source Human Query Audit Pack\n\n- passed: ${report.passed}\n- sampleCount: ${metrics.sampleCount}\n- wrongRouteCount: ${metrics.wrongRouteCount}\n- wrongCorpusCount: ${metrics.wrongCorpusCount}\n`, "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runMixedSourceHumanQueryAuditPackCli(): Promise<void> {
  const { report, output } = await runAndWriteMixedSourceHumanQueryAuditPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
}
