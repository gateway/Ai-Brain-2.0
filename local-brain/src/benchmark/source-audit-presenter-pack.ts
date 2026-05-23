import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { presentHumanReadableQueryResult } from "../mcp/query-presenter.js";
import { buildBenchmarkRuntimeMetadata, type BenchmarkRuntimeMetadata } from "./runtime-metadata.js";

interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly payload: Record<string, unknown>;
  readonly expectedTerms: readonly string[];
  readonly forbiddenTerms: readonly string[];
}

export interface SourceAuditPresenterPackRow {
  readonly id: string;
  readonly query: string;
  readonly answer: string;
  readonly missingTerms: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly passed: boolean;
}

export interface SourceAuditPresenterPackReport {
  readonly generatedAt: string;
  readonly benchmark: "source_audit_presenter_pack";
  readonly runtime: BenchmarkRuntimeMetadata;
  readonly sampleCount: number;
  readonly passed: boolean;
  readonly results: readonly SourceAuditPresenterPackRow[];
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

function scenarios(): readonly Scenario[] {
  return [
    {
      id: "typed_temporal_source_audit",
      query: "Where did the mid to late July travel answer come from?",
      payload: {
        queryContract: "direct_fact",
        finalClaimSource: "typed_temporal_anchor",
        evidenceCount: 2,
        duality: {
          claim: {
            text: "You went to The US The United on the trip."
          }
        },
        sourceTrail: [
          {
            sourceUri: "/tmp/omi/2026-05-18-note.md",
            quote: "Flight from Chiang Mai to the US. Time: User plans to fly to the US in mid-to-late July."
          }
        ],
        claimAudit: [
          {
            id: "temporal:1",
            claimText: "Travel to the US in mid-to-late July.",
            claimFamily: "temporal",
            supportKind: "typed_read_model",
            finalClaimSource: "typed_temporal_anchor",
            evidenceCount: 2,
            sourceTrail: [
              {
                sourceUri: "/tmp/omi/2026-05-18-note.md",
                quote: "Flight from Chiang Mai to the US. Time: User plans to fly to the US in mid-to-late July."
              }
            ],
            sourceQuotes: ["Flight from Chiang Mai to the US. Time: User plans to fly to the US in mid-to-late July."],
            supportStatus: "supported",
            faithfulnessStatus: "verified"
          }
        ]
      },
      expectedTerms: ["Source trail", "2026-05-18-note.md", "mid-to-late July"],
      forbiddenTerms: ["You went to The US The United"]
    },
    {
      id: "task_source_audit",
      query: "Where did the recent travel tasks come from?",
      payload: {
        queryContract: "task_list",
        finalClaimSource: "task_projection",
        evidenceCount: 1,
        answer: "Open tasks: Store Jeep with Tink.",
        sourceTrail: [
          {
            sourceUri: "/tmp/notes/travel-planning.md",
            quote: "Store Jeep with Tink."
          }
        ],
        claimAudit: [
          {
            id: "task:1",
            claimText: "Store Jeep with Tink.",
            claimFamily: "task",
            supportKind: "typed_read_model",
            finalClaimSource: "task_projection",
            evidenceCount: 1,
            sourceTrail: [
              {
                sourceUri: "/tmp/notes/travel-planning.md",
                quote: "Store Jeep with Tink."
              }
            ],
            sourceQuotes: ["Store Jeep with Tink."],
            supportStatus: "supported",
            faithfulnessStatus: "verified"
          }
        ]
      },
      expectedTerms: ["Source trail", "travel-planning.md", "Store Jeep"],
      forbiddenTerms: ["Open tasks:"]
    },
    {
      id: "relationship_source_audit",
      query: "Where did the Lauren answer come from?",
      payload: {
        queryContract: "source_audit",
        finalClaimSource: "relationship_memory",
        evidenceCount: 1,
        claimAudit: [
          {
            id: "relationship:1",
            claimText: "Lauren is represented by a relationship edge.",
            claimFamily: "relationship",
            supportKind: "relationship_memory",
            finalClaimSource: "relationship_memory",
            evidenceCount: 1,
            sourceTrail: [
              {
                sourceUri: "/tmp/relationships/lauren.md",
                quote: "Lauren relationship edge source."
              }
            ],
            sourceQuotes: ["Lauren relationship edge source."],
            supportStatus: "supported",
            faithfulnessStatus: "verified"
          }
        ],
        sourceTrail: [
          {
            sourceUri: "/tmp/relationships/lauren.md",
            quote: "Lauren relationship edge source."
          }
        ]
      },
      expectedTerms: ["Source trail", "Lauren", "relationship"],
      forbiddenTerms: []
    },
    {
      id: "career_section_source_audit",
      query: "Where did the Well Inked role come from?",
      payload: {
        queryContract: "work_history_report",
        finalClaimSource: "work_history_report_direct_read_model",
        evidenceCount: 1,
        answerSections: [
          {
            id: "employment_history",
            title: "Employment history",
            text: "Well Inked role evidence.",
            evidenceCount: 1,
            sourceTrail: [
              {
                sourceUri: "/tmp/career/well-inked.md",
                quote: "Well Inked role evidence."
              }
            ],
            claimAudit: [
              {
                id: "section:employment_history",
                claimText: "Well Inked role evidence.",
                claimFamily: "career",
                supportKind: "answer_section",
                finalClaimSource: "work_history_report_direct_read_model",
                evidenceCount: 1,
                sourceTrail: [
                  {
                    sourceUri: "/tmp/career/well-inked.md",
                    quote: "Well Inked role evidence."
                  }
                ],
                sourceQuotes: ["Well Inked role evidence."],
                supportStatus: "supported",
                faithfulnessStatus: "verified"
              }
            ]
          }
        ],
        claimAudit: [
          {
            id: "section:employment_history",
            claimText: "Well Inked role evidence.",
            claimFamily: "career",
            supportKind: "answer_section",
            finalClaimSource: "work_history_report_direct_read_model",
            evidenceCount: 1,
            sourceTrail: [
              {
                sourceUri: "/tmp/career/well-inked.md",
                quote: "Well Inked role evidence."
              }
            ],
            sourceQuotes: ["Well Inked role evidence."],
            supportStatus: "supported",
            faithfulnessStatus: "verified"
          }
        ],
        sourceTrail: [
          {
            sourceUri: "/tmp/career/well-inked.md",
            quote: "Well Inked role evidence."
          }
        ]
      },
      expectedTerms: ["Source trail", "Well Inked", "role"],
      forbiddenTerms: []
    },
    {
      id: "abstention_source_audit",
      query: "Where did the unsupported answer come from?",
      payload: {
        queryContract: "relationship_map",
        finalClaimSource: null,
        evidenceCount: 0,
        abstentionReason: "no_authoritative_evidence",
        claimAudit: [
          {
            id: "abstention:1",
            claimText: "no_authoritative_evidence",
            claimFamily: "abstention",
            supportKind: "abstention",
            finalClaimSource: null,
            evidenceCount: 0,
            sourceTrail: [],
            sourceQuotes: [],
            supportStatus: "abstained",
            faithfulnessStatus: "verified"
          }
        ]
      },
      expectedTerms: ["Source trail", "Abstention", "no_authoritative_evidence"],
      forbiddenTerms: []
    }
  ];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

function missingTerms(text: string, terms: readonly string[]): readonly string[] {
  const normalized = normalizeText(text);
  return terms.filter((term) => !normalized.includes(normalizeText(term)));
}

function forbiddenHits(text: string, terms: readonly string[]): readonly string[] {
  const normalized = normalizeText(text);
  return terms.filter((term) => normalized.includes(normalizeText(term)));
}

function runScenario(scenario: Scenario): SourceAuditPresenterPackRow {
  const rendered = presentHumanReadableQueryResult({
    query: scenario.query,
    payload: scenario.payload,
    detailMode: "compact"
  });
  const missing = missingTerms(rendered.answer, scenario.expectedTerms);
  const forbidden = forbiddenHits(rendered.answer, scenario.forbiddenTerms);
  return {
    id: scenario.id,
    query: scenario.query,
    answer: rendered.answer,
    missingTerms: missing,
    forbiddenHits: forbidden,
    passed: missing.length === 0 && forbidden.length === 0
  };
}

function toMarkdown(report: SourceAuditPresenterPackReport): string {
  const lines = [
    "# Source Audit Presenter Pack",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- sampleCount: ${report.sampleCount}`,
    `- passed: ${report.passed}`,
    "",
    "## Results",
    ""
  ];
  for (const row of report.results) {
    lines.push(`- ${row.id}: passed=${row.passed}`);
    lines.push(`  - answer: ${row.answer}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteSourceAuditPresenterPack(): Promise<{
  readonly report: SourceAuditPresenterPackReport;
  readonly output: { readonly jsonPath: string; readonly markdownPath: string };
}> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const results = scenarios().map(runScenario);
  const report: SourceAuditPresenterPackReport = {
    generatedAt: new Date().toISOString(),
    benchmark: "source_audit_presenter_pack",
    runtime: buildBenchmarkRuntimeMetadata({
      benchmarkMode: "sampled",
      sampleControls: {
        scenarioCount: results.length
      }
    }),
    sampleCount: results.length,
    passed: results.every((row) => row.passed),
    results
  };
  await mkdir(outputDir(), { recursive: true });
  const jsonPath = path.join(outputDir(), `source-audit-presenter-pack-${stamp}.json`);
  const markdownPath = path.join(outputDir(), `source-audit-presenter-pack-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return { report, output: { jsonPath, markdownPath } };
}

export async function runSourceAuditPresenterPackCli(): Promise<void> {
  const { output } = await runAndWriteSourceAuditPresenterPack();
  process.stdout.write(`${output.jsonPath}\n${output.markdownPath}\n`);
}
