import { readCodexMemory } from "./codex-memory-reader.js";
import { readExpandableMemory } from "../memory-packets/service.js";
import type { MemoryQueryPlan } from "./memory-query-plan.js";
import type { RecallResult } from "../types.js";
import type { StructuredAnswerSection } from "./types.js";

export interface InsightSupportBundle {
  readonly results: readonly RecallResult[];
  readonly sections: readonly StructuredAnswerSection[];
  readonly evidenceTexts: readonly string[];
  readonly sourceKinds: readonly string[];
  readonly selectedCorpora: readonly string[];
  readonly candidateCountsByCorpus: Record<string, number>;
  readonly queryTimeModelCalls: number;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function sourceKindFromResult(result: RecallResult): string {
  const provenanceKind = result.provenance?.source_kind;
  if (typeof provenanceKind === "string" && provenanceKind.trim()) return provenanceKind.trim();
  const uri = typeof result.provenance?.source_uri === "string" ? result.provenance.source_uri : "";
  if (uri.startsWith("codex://")) return "codex_session";
  if (uri.startsWith("omi://")) return "omi_note";
  if (uri.startsWith("pdf://")) return "pdf";
  if (uri.startsWith("repo://")) return "repo_doc";
  if (uri.startsWith("task-export://")) return "task_export";
  if (uri.startsWith("calendar-export://")) return "calendar_export";
  if (uri.startsWith("markdown://")) return "markdown";
  return String(result.memoryType ?? "unknown");
}

function sectionText(section: StructuredAnswerSection): string {
  return `${section.title}: ${section.text}`.replace(/\s+/gu, " ").trim();
}

function supportQueryVariants(queryText: string, plan: MemoryQueryPlan): readonly string[] {
  const variants = [queryText];
  const lowered = queryText.toLowerCase();
  if (/\btoken\s+waste\b/iu.test(queryText) && !/\bcodex\b/iu.test(queryText)) {
    variants.push(`Codex ${queryText}`);
  }
  if (/\b(?:what\s+did\s+we\s+learn|what\s+could\s+we\s+do\s+better|suggestions?|recommendations?|patterns?)\b/iu.test(queryText)) {
    variants.push(queryText.replace(/\bwhat\s+did\s+we\s+learn\b/iu, "source windows patterns suggestions"));
  }
  if (plan.projects.length > 0 && !plan.projects.some((project) => lowered.includes(project.toLowerCase()))) {
    variants.push(`${queryText} ${plan.projects.join(" ")}`);
  }
  if (/\b(?:pdf|paper|research|rag|temporal\s+kg|citation|vericite|lossless|techdoc)\b/iu.test(queryText)) {
    variants.push(`${queryText} temporal KG citation verification event windows source windows support paths`);
  }
  if (/\b(?:skill|automation|checklist|agent\s+rule|repeated\s+instructions?|reusable\s+skills?)\b/iu.test(queryText)) {
    variants.push(`${queryText} agent rules repeated instructions reusable skills checklist no hardcoded patches`);
  }
  if (/\b(?:stale|uncertain|calendar|travel|july|september|dates?|time\s+windows?)\b/iu.test(queryText)) {
    variants.push(`${queryText} mid to late July September stale travel tasks date confirmation calendar commitments`);
  }
  return uniqueStrings(variants);
}

export async function buildInsightSupportBundle(params: {
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plan: MemoryQueryPlan;
  readonly limit: number;
}): Promise<InsightSupportBundle | null> {
  const variants = supportQueryVariants(params.queryText, params.plan);
  const resultMap = new Map<string, RecallResult>();
  const sections: StructuredAnswerSection[] = [];
  const selectedCorpora: string[] = [];
  const candidateCountsByCorpus: Record<string, number> = {};
  let queryTimeModelCalls = 0;

  for (const variant of variants) {
    const expandable = await readExpandableMemory({
      namespaceId: params.namespaceId,
      queryText: variant,
      limit: Math.max(params.limit, 8)
    });
    if (expandable) {
      selectedCorpora.push("memory_packets");
      candidateCountsByCorpus.memory_packets = (candidateCountsByCorpus.memory_packets ?? 0) + expandable.results.length;
      queryTimeModelCalls += expandable.queryTimeModelCalls;
      for (const result of expandable.results) resultMap.set(result.memoryId, result);
      sections.push(...expandable.answerSections);
    }
  }

  if (/\b(?:codex|agent|session|token\s+waste|repeated\s+instructions?|skill|workflow|docs?\s+drift|changelog|benchmark)\b/iu.test(params.queryText)) {
    const codex = await readCodexMemory({
      namespaceId: params.namespaceId,
      queryText: params.queryText,
      limit: Math.max(params.limit, 8)
    });
    if (codex) {
      selectedCorpora.push("codex_sessions");
      candidateCountsByCorpus.codex_sessions = codex.results.length;
      for (const result of codex.results) resultMap.set(result.memoryId, result);
      sections.push(...codex.answerSections);
    }
  }

  const results = [...resultMap.values()].slice(0, Math.max(params.limit, 8));
  if (results.length === 0 && sections.length === 0) return null;

  const evidenceTexts = uniqueStrings([
    ...sections.map(sectionText),
    ...results.map((result) => result.content)
  ]).slice(0, 24);

  return {
    results,
    sections: sections.slice(0, 12),
    evidenceTexts,
    sourceKinds: uniqueStrings(results.map(sourceKindFromResult)),
    selectedCorpora: uniqueStrings(selectedCorpora),
    candidateCountsByCorpus,
    queryTimeModelCalls
  };
}
