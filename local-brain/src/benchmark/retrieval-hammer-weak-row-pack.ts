import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface HammerRow {
  readonly id?: string;
  readonly query?: string;
  readonly expectedTerms?: readonly string[];
  readonly missingTerms?: readonly string[];
  readonly finalClaimSource?: string | null;
  readonly queryContract?: string | null;
  readonly retrievalDomain?: string | null;
  readonly selectedReader?: string | null;
  readonly evidenceCount?: number;
  readonly sourceTrailCount?: number;
  readonly claimAuditCount?: number;
  readonly queryTimeModelCalls?: number;
  readonly latencyMs?: number;
  readonly quality?: string;
  readonly rating?: number;
  readonly residualOwner?: string;
  readonly passed?: boolean;
}

function outputDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmark-results");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function latestHammerArtifact(): Promise<string> {
  const dir = outputDir();
  const files = (await readdir(dir))
    .filter((file) => /^retrieval-hammer-audit-300-.*\.json$/u.test(file))
    .sort()
    .reverse();
  const latest = files[0];
  if (!latest) {
    throw new Error("No retrieval-hammer-audit-300 artifact found. Run benchmark:retrieval-hammer-audit-300 first.");
  }
  return path.join(dir, latest);
}

function weakRows(rows: readonly HammerRow[]): readonly HammerRow[] {
  return rows.filter((row) => {
    const quality = row.quality ?? (row.passed ? "strong" : "weak");
    return quality === "weak" || quality === "fail" || (row.missingTerms?.length ?? 0) > 0;
  });
}

function countBy(rows: readonly HammerRow[], key: (row: HammerRow) => string | null | undefined): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = key(row) || "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function markdown(report: any): string {
  const lines = [
    "# Retrieval Hammer Weak Row Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sourceArtifact: ${report.sourceArtifact}`,
    `- passed: ${report.passed}`,
    `- totalRows: ${report.metrics.totalRows}`,
    `- weakRows: ${report.metrics.weakRows}`,
    `- failRows: ${report.metrics.failRows}`,
    `- missingExpectedTermRows: ${report.metrics.missingExpectedTermRows}`,
    `- queryTimeModelCalls: ${report.metrics.queryTimeModelCalls}`,
    "",
    "## Residual Owners",
    "",
    ...Object.entries(report.metrics.residualOwnerCounts).map(([owner, count]) => `- ${owner}: ${count}`),
    "",
    "## Missing Terms",
    "",
    ...Object.entries(report.metrics.missingTermCounts).map(([term, count]) => `- ${term}: ${count}`),
    "",
    "## Rows",
    "",
    ...report.rows.map(
      (row: HammerRow) =>
        `- ${row.id ?? "unknown"}: quality=${row.quality ?? "unknown"}, rating=${row.rating ?? "unknown"}, owner=${row.residualOwner ?? "unknown"}, missing=${row.missingTerms?.join("|") || "none"}, reader=${row.selectedReader ?? "unknown"}, finalClaimSource=${row.finalClaimSource ?? "unknown"}, evidence=${row.evidenceCount ?? 0}, sources=${row.sourceTrailCount ?? 0}, claimAudit=${row.claimAuditCount ?? 0}, query="${row.query ?? ""}"`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteRetrievalHammerWeakRowPack(): Promise<{
  readonly report: any;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const sourceArtifact = await latestHammerArtifact();
  const source = JSON.parse(await readFile(sourceArtifact, "utf8")) as { readonly results?: readonly HammerRow[] };
  const rows = weakRows(source.results ?? []);
  const missingTerms = rows.flatMap((row) => row.missingTerms ?? []);
  const report = {
    generatedAt: new Date().toISOString(),
    benchmark: "retrieval_hammer_weak_row_pack",
    artifactSchemaVersion: "retrieval_hammer_weak_row_pack_v1",
    sourceArtifact,
    passed: rows.length === 0,
    metrics: {
      totalRows: rows.length,
      weakRows: rows.filter((row) => (row.quality ?? "weak") === "weak").length,
      failRows: rows.filter((row) => (row.quality ?? "weak") === "fail").length,
      missingExpectedTermRows: rows.filter((row) => (row.missingTerms?.length ?? 0) > 0).length,
      supportedZeroEvidenceRows: rows.filter((row) => (row.evidenceCount ?? 0) <= 0).length,
      supportedEmptySourceTrailRows: rows.filter((row) => (row.evidenceCount ?? 0) > 0 && (row.sourceTrailCount ?? 0) === 0).length,
      supportedMissingClaimAuditRows: rows.filter((row) => (row.evidenceCount ?? 0) > 0 && (row.claimAuditCount ?? 0) === 0).length,
      queryTimeModelCalls: rows.reduce((sum, row) => sum + (row.queryTimeModelCalls ?? 0), 0),
      residualOwnerCounts: countBy(rows, (row) => row.residualOwner),
      selectedReaderCounts: countBy(rows, (row) => row.selectedReader),
      finalClaimSourceCounts: countBy(rows, (row) => row.finalClaimSource),
      missingTermCounts: missingTerms.reduce<Record<string, number>>((counts, term) => {
        counts[term] = (counts[term] ?? 0) + 1;
        return counts;
      }, {})
    },
    rows
  };
  await mkdir(outputDir(), { recursive: true });
  const runStamp = stamp();
  const jsonPath = path.join(outputDir(), `retrieval-hammer-weak-row-pack-${runStamp}.json`);
  const markdownPath = path.join(outputDir(), `retrieval-hammer-weak-row-pack-${runStamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runRetrievalHammerWeakRowPackCli(): Promise<void> {
  const { report, output } = await runAndWriteRetrievalHammerWeakRowPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n${JSON.stringify({ passed: report.passed, metrics: report.metrics }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
