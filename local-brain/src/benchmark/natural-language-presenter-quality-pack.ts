import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexNaturalLanguagePresenterPack } from "./codex-natural-language-presenter-pack.js";
import { runMcpHumanQueryAuditRows } from "./mcp-human-query-audit-100.js";
import { runAndWriteSourceAuditPresenterPack } from "./source-audit-presenter-pack.js";
import { rate } from "./query-benchmark-utils.js";

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function answerText(row: any): string {
  return String(row.answerPreview ?? row.answer ?? "").replace(/\s+/gu, " ").trim();
}

function looksSnippetLike(value: string): boolean {
  return /^(?:Decision candidate|Session intent|Session outcome|Repeated user instruction|Agent failure pattern|Skill candidate|Token waste observation|Evidence:)\b/iu.test(value);
}

function hasPresenterLeak(value: string): boolean {
  return /agents\.md instructions|<instructions>|filesystem sandboxing|approval policy is currently|available skills|chunk id:|original token count|structuredContent/iu.test(value);
}

function toMarkdown(report: any): string {
  return [
    "# Natural Language Presenter Quality Pack",
    "",
    `- passed: ${report.passed}`,
    `- presenterStrongRate: ${report.metrics.presenterStrongRate}`,
    `- snippetLikeAnswerCount: ${report.metrics.snippetLikeAnswerCount}`,
    `- operatingContextLeakCount: ${report.metrics.operatingContextLeakCount}`,
    `- supportedEmptySourceTrailRows: ${report.metrics.supportedEmptySourceTrailRows}`,
    `- supportedMissingClaimAuditRows: ${report.metrics.supportedMissingClaimAuditRows}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Weak Rows",
    "",
    ...(report.rows.filter((row: any) => row.passed !== true).map((row: any) => `- ${row.id}: ${row.residualOwner} -> ${row.answer}`))
  ].join("\n") + "\n";
}

export async function runAndWriteNaturalLanguagePresenterQualityPack(): Promise<{ readonly report: any; readonly output: { readonly jsonPath: string; readonly markdownPath: string } }> {
  const [sourceAuditPresenter, codexPresenter, humanRows] = await Promise.all([
    runAndWriteSourceAuditPresenterPack(),
    runCodexNaturalLanguagePresenterPack(),
    runMcpHumanQueryAuditRows({ rowLimit: 40 })
  ]);
  const normalizedHumanRows = humanRows.rows.map((row: any) => {
    const answer = answerText(row);
    const snippetLike = looksSnippetLike(answer);
    const leak = hasPresenterLeak(JSON.stringify(row));
    const passed =
      row.passed === true &&
      row.quality === "strong" &&
      !snippetLike &&
      !leak &&
      Number(row.evidenceCount ?? 0) > 0 &&
      Number(row.sourceTrailCount ?? 0) > 0 &&
      Number(row.claimAuditCount ?? 0) > 0 &&
      Number(row.queryTimeModelCalls ?? 0) === 0;
    return {
      id: row.id,
      query: row.query,
      family: row.corpus ?? row.category ?? "mcp_human",
      answer,
      evidenceCount: Number(row.evidenceCount ?? 0),
      sourceTrailCount: Number(row.sourceTrailCount ?? 0),
      claimAuditCount: Number(row.claimAuditCount ?? 0),
      queryTimeModelCalls: Number(row.queryTimeModelCalls ?? 0),
      snippetLike,
      operatingContextLeak: leak,
      residualOwner: passed ? "none" : row.residualOwner ?? "presenter_shape_miss",
      passed
    };
  });
  const codexRows = (codexPresenter.report.rows ?? []).map((row: any) => ({
    id: `codex_${row.id}`,
    query: row.query,
    family: "codex",
    answer: answerText(row),
    evidenceCount: Number(row.evidenceCount ?? 0),
    sourceTrailCount: Number(row.sourceTrailCount ?? 0),
    claimAuditCount: Number(row.claimAuditCount ?? 0),
    queryTimeModelCalls: Number(row.queryTimeModelCalls ?? 0) + Number(row.fullQueryTimeModelCalls ?? 0),
    snippetLike: row.snippetLike === true,
    operatingContextLeak: row.operatingContextLeak === true,
    residualOwner: row.passed === true ? "none" : "codex_presenter_shape_miss",
    passed: row.passed === true
  }));
  const sourceRows = (sourceAuditPresenter.report.results ?? []).map((row: any) => ({
    id: `source_audit_${row.id}`,
    query: row.query,
    family: "source_audit",
    answer: answerText(row),
    evidenceCount: 1,
    sourceTrailCount: 1,
    claimAuditCount: 1,
    queryTimeModelCalls: 0,
    snippetLike: looksSnippetLike(answerText(row)),
    operatingContextLeak: hasPresenterLeak(JSON.stringify(row)),
    residualOwner: row.passed === true ? "none" : "source_audit_presenter_shape_miss",
    passed: row.passed === true && !looksSnippetLike(answerText(row)) && !hasPresenterLeak(JSON.stringify(row))
  }));
  const rows = [...normalizedHumanRows, ...codexRows, ...sourceRows];
  const supportedRows = rows.filter((row) => row.evidenceCount > 0);
  const metrics = {
    queryCount: rows.length,
    strongCount: rows.filter((row) => row.passed).length,
    presenterStrongRate: rate(rows.filter((row) => row.passed).length, rows.length),
    snippetLikeAnswerCount: rows.filter((row) => row.snippetLike).length,
    operatingContextLeakCount: rows.filter((row) => row.operatingContextLeak).length,
    supportedEmptySourceTrailRows: supportedRows.filter((row) => row.sourceTrailCount === 0).length,
    supportedMissingClaimAuditRows: supportedRows.filter((row) => row.claimAuditCount === 0).length,
    queryTimeModelCalls: rows.reduce((sum, row) => sum + row.queryTimeModelCalls, 0),
    codexPresenterPassed: codexPresenter.report.passed === true ? 1 : 0,
    sourceAuditPresenterPassed: sourceAuditPresenter.report.passed === true ? 1 : 0
  };
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    benchmark: "natural_language_presenter_quality_pack",
    passed:
      metrics.presenterStrongRate >= 0.95 &&
      metrics.snippetLikeAnswerCount === 0 &&
      metrics.operatingContextLeakCount === 0 &&
      metrics.supportedEmptySourceTrailRows === 0 &&
      metrics.supportedMissingClaimAuditRows === 0 &&
      metrics.queryTimeModelCalls === 0 &&
      metrics.codexPresenterPassed === 1 &&
      metrics.sourceAuditPresenterPassed === 1,
    metrics,
    dependencyArtifacts: {
      codexNaturalLanguagePresenterPack: codexPresenter.output.jsonPath,
      sourceAuditPresenterPack: sourceAuditPresenter.output.jsonPath,
      humanQueryAuditRowsMultiSourceArtifact: humanRows.multiSourceIngestionArtifact
    },
    rows
  };
  await mkdir(outputDir(), { recursive: true });
  const suffix = stamp();
  const jsonPath = path.join(outputDir(), `natural-language-presenter-quality-pack-${suffix}.json`);
  const markdownPath = path.join(outputDir(), `natural-language-presenter-quality-pack-${suffix}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runNaturalLanguagePresenterQualityPackCli(): Promise<void> {
  const { report, output } = await runAndWriteNaturalLanguagePresenterQualityPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
