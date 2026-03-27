import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withMaintenanceLock } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { runSemanticDecay } from "../jobs/semantic-decay.js";
import { runTemporalNodeArchival, runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { getOpsRelationshipGraph } from "../ops/service.js";
import { executeProvenanceAuditWorker } from "../ops/runtime-worker-service.js";
import { searchMemory } from "../retrieval/service.js";
import { resetDatabase, runLifeReplayBenchmark, seedNamespace } from "./life-replay.js";

interface ScaleQuerySpec {
  readonly name: string;
  readonly query: string;
  readonly expectedTerms: readonly string[];
  readonly expectedExcludes?: readonly string[];
  readonly minimumConfidence: "confident" | "weak" | "missing";
  readonly expectedFollowUpAction?: "none" | "suggest_verification" | "route_to_clarifications";
  readonly expectedRetrievalMode?: "lexical" | "hybrid";
  readonly expectedRankingKernel?: "app_fused" | "sql_hybrid_core" | "sql_hybrid_unified";
  readonly expectedVectorFallbackReason?: string;
  readonly maxLexicalCandidateCount?: number;
  readonly maxBoundedEventSupportCount?: number;
  readonly referenceNow?: string;
}

interface ScaleQueryResult {
  readonly name: string;
  readonly query: string;
  readonly latencyMs: number;
  readonly confidence: "confident" | "weak" | "missing";
  readonly followUpAction: string | null;
  readonly retrievalMode: string | null;
  readonly rankingKernel: string | null;
  readonly vectorFallbackReason: string | null;
  readonly lexicalCandidateCount: number | null;
  readonly boundedEventSupportCount: number | null;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface ScaleGraphResult {
  readonly name: string;
  readonly passed: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly failures: readonly string[];
}

export interface LifeScaleBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly baseline: {
    readonly confidentCount: number;
    readonly weakCount: number;
    readonly missingCount: number;
    readonly passed: boolean;
    readonly pack: {
      readonly confidentCount: number;
      readonly weakCount: number;
      readonly missingCount: number;
    };
  };
  readonly generatedArtifacts: {
    readonly medium: number;
    readonly large: number;
    readonly noisy: number;
    readonly transcripts: number;
    readonly holdout: number;
    readonly transcriptCorrectionPasses: number;
    readonly total: number;
  };
  readonly clarificationCounts: Record<string, number>;
  readonly archivalCounts: {
    readonly semantic: Record<string, number>;
    readonly temporal: Record<string, number>;
  };
  readonly graphResults: readonly ScaleGraphResult[];
  readonly queryResults: readonly ScaleQueryResult[];
  readonly latency: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
  };
  readonly quality: {
    readonly confidentCount: number;
    readonly weakCount: number;
    readonly missingCount: number;
  };
  readonly qualityDelta: {
    readonly confidentDelta: number;
    readonly weakDelta: number;
    readonly missingDelta: number;
  };
  readonly passed: boolean;
}

interface GeneratedArtifact {
  readonly path: string;
  readonly sourceChannel: string;
  readonly capturedAt: string;
  readonly sourceType?: "markdown" | "transcript";
  readonly metadata?: Record<string, unknown>;
}

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function rootDir(): string {
  return path.resolve(thisDir(), "../..");
}

function outputDir(): string {
  return path.resolve(rootDir(), "benchmark-results");
}

function generatedFixtureRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "life-scale");
}

function confidenceRank(value: "confident" | "weak" | "missing"): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    default:
      return 0;
  }
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function isoAt(dayOffset: number, hour = 9): string {
  const date = new Date(Date.UTC(2026, 3, 1 + dayOffset, hour, 0, 0));
  return date.toISOString();
}

function buildMediumFile(fileIndex: number, entryCount: number): string {
  const companions = ["Gummi", "Dan", "Ben", "Lauren", "Tim", "Maya", "Kiko", "Jonas"];
  const places = ["Yellow co-working space", "Chiang Mai", "Lake Tahoe", "Bend, Oregon", "Koh Samui"];
  const projects = ["Two-Way", "Well Inked", "Photo Club", "AI Brain"];
  const lines = [`# Medium Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const companion = companions[(fileIndex + index) % companions.length];
    const place = places[(fileIndex * 3 + index) % places.length];
    const project = projects[(fileIndex * 5 + index) % projects.length];
    lines.push(
      `On April ${(index % 28) + 1}, 2026 Steve spent the morning at ${place} with ${companion} and worked on ${project}. Later he reviewed the relationship graph, place hierarchy, and current truth around Chiang Mai, Thailand.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildLargeFile(fileIndex: number, entryCount: number): string {
  const companions = ["Dan", "Gummi", "Ben", "Lauren", "Tim", "Maya", "Kiko", "Jonas", "Priya", "Nia", "Tessa", "Leo"];
  const places = [
    "Yellow co-working space in Chiang Mai, Thailand",
    "Tahoe City in Lake Tahoe, California",
    "Bend, Oregon",
    "Koh Samui, Thailand",
    "Mexico City, Mexico",
    "Munich, Germany"
  ];
  const orgs = ["Two-Way", "Well Inked", "Photo Club", "The Samui Experience"];
  const lines = [`# Large Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const companion = companions[(fileIndex + index) % companions.length];
    const secondary = companions[(fileIndex + index + 4) % companions.length];
    const place = places[(fileIndex * 7 + index) % places.length];
    const org = orgs[(fileIndex * 2 + index) % orgs.length];
    lines.push(
      `On May ${(index % 28) + 1}, 2026 Steve met ${companion} and ${secondary} at ${place}. They talked about ${org}, the social graph, current employer truth, and how place containment should expand from city to country without inventing new residence facts.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildNoisyFile(fileIndex: number, entryCount: number): string {
  const aliasVariants = ["Gumee", "Gumi", "Stephan", "Stephen Tietze"];
  const vaguePlaces = ["the summer cabin", "the old house by the beach", "the London building south wing", "the cabin near the lake"];
  const nearDuplicateProjects = ["Tokyo Research", "The Tokyo Project", "Project Tokyo", "Tokyo Research Packet"];
  const lines = [`# Noisy Replay Slice ${fileIndex + 1}`, ""];
  for (let index = 0; index < entryCount; index += 1) {
    const alias = aliasVariants[(fileIndex + index) % aliasVariants.length];
    const vaguePlace = vaguePlaces[(fileIndex * 3 + index) % vaguePlaces.length];
    const project = nearDuplicateProjects[(fileIndex * 5 + index) % nearDuplicateProjects.length];
    lines.push(
      `Uncle said ${alias} left the notes for ${project} at ${vaguePlace}. Later Dad asked whether ${project} was the same as Tokyo Research, but nobody clarified which person or place they meant.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildTranscriptFile(fileIndex: number): string {
  const variants = [
    {
      speaker: "Dan",
      text: "The brain remembering last week without rereading every note is the thing we need to test."
    },
    {
      speaker: "Danny",
      text: "Austin still sounds like a good fallback spot if Chiang Mai gets smoky."
    },
    {
      speaker: "Daniel",
      text: "SXSW in Austin still feels familiar, but I do not live there now."
    },
    {
      speaker: "D.",
      text: "The graph should remember last weekend without rereading every file."
    },
    {
      speaker: "SPEAKER_00",
      text: "I am just leaving a rough voice memo about meeting Jules at coworking."
    },
    {
      speaker: "Steve",
      text: "I need the graph to expand from Steve to Chiang Mai to Thailand and keep the history intact."
    },
    {
      speaker: "Danny",
      text: "Austin still feels familiar, but it is only a fallback spot and I do not live there now."
    },
    {
      speaker: "Dan",
      text: "Daniel and Dan are the same person in these notes, and Austin is just a fallback idea."
    }
  ] as const;
  const first = variants[fileIndex % variants.length];
  const second = variants[(fileIndex + 1) % variants.length];

  return JSON.stringify(
    {
      text: `${first.text} ${second.text}`,
      language: "en",
      duration_seconds: 18.4,
      segments: [
        {
          start: 0,
          end: 8.6,
          text: first.text,
          speaker: first.speaker,
          confidence: 0.92
        },
        {
          start: 9.1,
          end: 18.4,
          text: second.text,
          speaker: second.speaker,
          confidence: 0.89
        }
      ],
      words: [],
      model: "benchmark/transcript-scale",
      metadata: {
        diarization_used: true,
        speaker_count: 2,
        speakers: [first.speaker, second.speaker]
      }
    },
    null,
    2
  );
}

async function writeGeneratedArtifacts(): Promise<{
  readonly medium: readonly GeneratedArtifact[];
  readonly large: readonly GeneratedArtifact[];
  readonly noisy: readonly GeneratedArtifact[];
  readonly transcripts: readonly GeneratedArtifact[];
  readonly holdout: readonly GeneratedArtifact[];
}> {
  const root = generatedFixtureRoot();
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const medium: GeneratedArtifact[] = [];
  const large: GeneratedArtifact[] = [];
  const noisy: GeneratedArtifact[] = [];
  const transcripts: GeneratedArtifact[] = [];
  const holdout: GeneratedArtifact[] = [];

  for (let index = 0; index < 48; index += 1) {
    const filePath = path.join(root, `medium-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildMediumFile(index, 60), "utf8");
    medium.push({
      path: filePath,
      sourceChannel: `life-scale:medium:${index + 1}`,
      capturedAt: isoAt(index)
    });
  }

  for (let index = 0; index < 96; index += 1) {
    const filePath = path.join(root, `large-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildLargeFile(index, 90), "utf8");
    large.push({
      path: filePath,
      sourceChannel: `life-scale:large:${index + 1}`,
      capturedAt: isoAt(index, 13)
    });
  }

  for (let index = 0; index < 56; index += 1) {
    const filePath = path.join(root, `noisy-${String(index + 1).padStart(2, "0")}.md`);
    await writeFile(filePath, buildNoisyFile(index, 50), "utf8");
    noisy.push({
      path: filePath,
      sourceChannel: `life-scale:noisy:${index + 1}`,
      capturedAt: isoAt(index, 18)
    });
  }

  for (let index = 0; index < 48; index += 1) {
    const filePath = path.join(root, `transcript-${String(index + 1).padStart(2, "0")}.json`);
    await writeFile(filePath, buildTranscriptFile(index), "utf8");
    transcripts.push({
      path: filePath,
      sourceChannel: `life-scale:transcript:${index + 1}`,
      capturedAt: isoAt(index, 20),
      sourceType: "transcript",
      metadata: {
        fixture_kind: "life_scale_transcript",
        captured_at: isoAt(index, 20)
      }
    });
  }

  const holdoutWeekendPath = path.join(root, "holdout-weekend-relative-time.md");
  await writeFile(
    holdoutWeekendPath,
    [
      "# Holdout Weekend Relative Time",
      "",
      "On Saturday, April 4, 2026 Steve spent the afternoon at Yellow co-working space in Chiang Mai and finished planning the next Brain replay pass.",
      "Later that night he met Dan for karaoke at North Gate and they talked about how the brain should answer questions about last weekend without rereading every file.",
      "On Sunday morning, April 5, 2026 Steve grabbed khao soi before heading back home."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutWeekendPath,
    sourceChannel: "life-scale:holdout:weekend-relative-time",
    capturedAt: "2026-04-04T18:30:00Z"
  });

  const holdoutSemanticAnchorPath = path.join(root, "holdout-semantic-anchors.md");
  await writeFile(
    holdoutSemanticAnchorPath,
    [
      "# Holdout Semantic Anchors",
      "",
      "On Friday, April 10, 2026 Steve met Dan for the first time at North Gate Jazz Co-op in Chiang Mai.",
      "Later that night Steve and Dan walked to Night Noodle Alley for noodles and talked about memory graphs.",
      "The Turkey trip wrapped on April 17, 2026 after Steve spent the week in Istanbul.",
      "After the Turkey trip, on April 18, 2026 Steve worked from Yellow co-working space and debriefed the trip."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutSemanticAnchorPath,
    sourceChannel: "life-scale:holdout:semantic-anchors",
    capturedAt: "2026-04-18T11:00:00Z"
  });

  const holdoutPersonaPath = path.join(root, "holdout-persona-pressure.md");
  await writeFile(
    holdoutPersonaPath,
    [
      "# Holdout Persona Pressure",
      "",
      "Dan said Austin still feels familiar, but it is only a fallback spot and he does not live there now.",
      "Later Danny corrected the rough transcript label and said he was still talking about Austin as a fallback.",
      "A follow-up note clarified that Daniel and Dan are the same person in these notes."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutPersonaPath,
    sourceChannel: "life-scale:holdout:persona-pressure",
    capturedAt: "2026-04-24T10:00:00Z"
  });

  const holdoutNarrativeAnchorPath = path.join(root, "holdout-narrative-anchors.md");
  await writeFile(
    holdoutNarrativeAnchorPath,
    [
      "# Holdout Narrative Anchors",
      "",
      "The Chiang Rai weekend started on May 2, 2026 when Steve drove north with Dan.",
      "Later that night they walked the night market and talked about whether the brain could answer questions about that weekend without rereading every note.",
      "After the Chiang Rai weekend, on May 4, 2026 Steve spent the afternoon at Yellow co-working space cleaning up retrieval benchmarks."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutNarrativeAnchorPath,
    sourceChannel: "life-scale:holdout:narrative-anchors",
    capturedAt: "2026-05-04T13:30:00Z"
  });

  const holdoutTranscriptPressurePath = path.join(root, "holdout-transcript-pressure.md");
  await writeFile(
    holdoutTranscriptPressurePath,
    [
      "# Holdout Transcript Pressure",
      "",
      "A rough voice note first called Jules 'Jewels' and said the meetup happened by the old coffee place.",
      "A later correction said Jules was the right name and the meetup happened at Yellow co-working space in Chiang Mai.",
      "Another follow-up clarified that the old coffee place comment was just a rough memory and not the final location."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutTranscriptPressurePath,
    sourceChannel: "life-scale:holdout:transcript-pressure",
    capturedAt: "2026-05-06T09:45:00Z"
  });

  const holdoutClarificationPressurePath = path.join(root, "holdout-clarification-pressure.md");
  await writeFile(
    holdoutClarificationPressurePath,
    [
      "# Holdout Clarification Pressure",
      "",
      "Mom mentioned Uncle again but never said which uncle she meant.",
      "Steve also referenced the summer cabin, but the note still never pinned down where it was.",
      "The whole point of the note was that the brain should abstain and ask for clarification instead of guessing."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutClarificationPressurePath,
    sourceChannel: "life-scale:holdout:clarification-pressure",
    capturedAt: "2026-05-07T08:15:00Z"
  });

  const holdoutSubjectBoundProfilePath = path.join(root, "holdout-subject-bound-profile.md");
  await writeFile(
    holdoutSubjectBoundProfilePath,
    [
      "# Holdout Subject Bound Profile",
      "",
      "Maya Serra has been reading about psychology programs and wants to work in counseling.",
      "Maya Serra said counseling and mental health work feel like the right path for her.",
      "Leo Navarro wants to open a bike shop someday.",
      "Leo Navarro has not picked an academic field."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutSubjectBoundProfilePath,
    sourceChannel: "life-scale:holdout:subject-bound-profile",
    capturedAt: "2026-05-08T09:30:00Z"
  });

  const holdoutSharedGuardrailPath = path.join(root, "holdout-shared-guardrail.md");
  await writeFile(
    holdoutSharedGuardrailPath,
    [
      "# Holdout Shared Guardrail",
      "",
      "Nina relaxes by doing yoga and cooking.",
      "Omar relaxes by playing chess and reading science fiction.",
      "The note is intentionally here to make sure the brain does not invent overlap when there is none."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutSharedGuardrailPath,
    sourceChannel: "life-scale:holdout:shared-guardrail",
    capturedAt: "2026-05-08T11:15:00Z"
  });

  const holdoutProjectSupersessionPath = path.join(root, "holdout-project-supersession.md");
  await writeFile(
    holdoutProjectSupersessionPath,
    [
      "# Holdout Project Supersession",
      "",
      "Earlier notes described Project Atlas as sync-first and always online during the first pilot.",
      "After repeated sync failures in low-connectivity environments, Steve decided to move Project Atlas toward offline first capture.",
      "The goal was to prevent data loss and reduce operator frustration during remote use."
    ].join("\n"),
    "utf8"
  );
  holdout.push({
    path: holdoutProjectSupersessionPath,
    sourceChannel: "life-scale:holdout:project-supersession",
    capturedAt: "2026-05-09T10:45:00Z"
  });

  return { medium, large, noisy, transcripts, holdout };
}

async function runTranscriptCorrectionChains(namespaceId: string): Promise<number> {
  const root = generatedFixtureRoot();
  const chains = [
    {
      path: path.join(root, "correction-chain-turkey.json"),
      sourceChannel: "life-scale:correction:turkey",
      versions: [
        { capturedAt: "2026-04-15T09:00:00Z", speaker: "Steve", text: "I said the Turkey conference is in Istanbul this year." },
        { capturedAt: "2026-04-15T09:05:00Z", speaker: "Steve", text: "I said the Turkey conference is in Ankara this year." },
        { capturedAt: "2026-04-15T09:10:00Z", speaker: "Steve", text: "I said the Turkey conference is in Izmir this year." }
      ]
    },
    {
      path: path.join(root, "correction-chain-sxsw.json"),
      sourceChannel: "life-scale:correction:sxsw",
      versions: [
        { capturedAt: "2026-04-16T11:00:00Z", speaker: "SPEAKER_00", text: "I said SXSW in Austin still feels familiar to me." },
        { capturedAt: "2026-04-16T11:05:00Z", speaker: "Danny", text: "I said SXSW in Austin still feels familiar to me." },
        { capturedAt: "2026-04-16T11:10:00Z", speaker: "Dan", text: "I said SXSW in Austin still feels familiar to me." }
      ]
    },
    {
      path: path.join(root, "correction-chain-austin.json"),
      sourceChannel: "life-scale:correction:austin",
      versions: [
        { capturedAt: "2026-04-20T10:00:00Z", speaker: "Danny", text: "Austin still sounds like a good fallback spot." },
        { capturedAt: "2026-04-20T10:04:00Z", speaker: "Dan", text: "Austin is only a fallback spot and I do not live there now." },
        { capturedAt: "2026-04-20T10:09:00Z", speaker: "Daniel", text: "Daniel and Dan are the same person in these notes, and Austin is just a fallback." }
      ]
    },
    {
      path: path.join(root, "correction-chain-jules.json"),
      sourceChannel: "life-scale:correction:jules",
      versions: [
        { capturedAt: "2026-04-22T08:00:00Z", speaker: "SPEAKER_00", text: "I left a rough memo saying I met Jules at coworking." },
        { capturedAt: "2026-04-22T08:03:00Z", speaker: "Steve", text: "Correction, I met Jules at Yellow co-working space." },
        { capturedAt: "2026-04-22T08:07:00Z", speaker: "Steve", text: "Final correction, I met Jules at Yellow co-working space in Chiang Mai." }
      ]
    }
  ] as const;

  let passCount = 0;
  for (const chain of chains) {
    for (const version of chain.versions) {
      await writeFile(
        chain.path,
        JSON.stringify(
          {
            text: version.text,
            language: "en",
            duration_seconds: 6.4,
            segments: [
              {
                start: 0,
                end: 6.4,
                text: version.text,
                speaker: version.speaker,
                confidence: 0.92
              }
            ],
            words: [],
            model: "benchmark/transcript-correction"
          },
          null,
          2
        ),
        "utf8"
      );
      await ingestArtifact({
        inputUri: chain.path,
        namespaceId,
        sourceType: "transcript",
        sourceChannel: chain.sourceChannel,
        capturedAt: version.capturedAt,
        metadata: {
          fixture_kind: "life_scale_transcript_correction",
          captured_at: version.capturedAt
        }
      });
      passCount += 1;
    }
  }

  return passCount;
}

async function ingestGeneratedArtifacts(namespaceId: string, artifacts: readonly GeneratedArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    await ingestArtifact({
      inputUri: artifact.path,
      namespaceId,
      sourceType: artifact.sourceType ?? "markdown",
      sourceChannel: artifact.sourceChannel,
      capturedAt: artifact.capturedAt,
      metadata: artifact.metadata
    });
  }
}

async function rebuildNamespace(namespaceId: string): Promise<void> {
  await runRelationshipAdjudication(namespaceId, {
    limit: 2400,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  await runCandidateConsolidation(namespaceId, 2400);
  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, {
      layer,
      lookbackDays: 6000,
      maxMembersPerNode: 512
    });
  }
  await runSemanticDecay(namespaceId, {
    limit: 1600,
    inactivityHours: 24 * 30,
    coldInactivityHours: 24 * 90,
    decayFactor: 0.5,
    minimumScore: 0.1
  });
  await runTemporalNodeArchival(namespaceId, {
    limit: 2400
  });
  await executeProvenanceAuditWorker({
    triggerType: "repair",
    workerId: "life-scale:provenance-audit"
  });
}

async function analyzeScaleTables(): Promise<void> {
  const tables = [
    "episodic_memory",
    "semantic_memory",
    "procedural_memory",
    "relationship_memory",
    "relationship_candidates",
    "memory_entity_mentions",
    "temporal_nodes",
    "temporal_node_members",
    "narrative_events",
    "narrative_scenes",
    "narrative_event_members",
    "artifacts",
    "artifact_observations",
    "artifact_chunks",
    "transcript_utterances",
    "entities"
  ];

  for (const tableName of tables) {
    await queryRows(`ANALYZE ${tableName}`);
  }
}

const SCALE_QUERY_SPECS: readonly ScaleQuerySpec[] = [
  {
    name: "current_home",
    query: "where does Steve live?",
    expectedTerms: ["Chiang Mai"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_unified",
    maxLexicalCandidateCount: 20
  },
  {
    name: "current_employer",
    query: "where does Steve work?",
    expectedTerms: ["Two-Way"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_unified",
    maxLexicalCandidateCount: 24
  },
  {
    name: "friends",
    query: "who are Steve's friends?",
    expectedTerms: ["Dan", "Ben", "Lauren"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_unified",
    maxLexicalCandidateCount: 16
  },
  {
    name: "current_project",
    query: "what is Steve working on?",
    expectedTerms: ["Two-Way"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_unified",
    maxLexicalCandidateCount: 24
  },
  {
    name: "yellow_event",
    query: "what happened at Yellow co-working space?",
    expectedTerms: ["Yellow"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core",
    expectedVectorFallbackReason: "planner:branch_pruned",
    maxLexicalCandidateCount: 12,
    maxBoundedEventSupportCount: 2
  },
  {
    name: "transcript_graph_memory",
    query: "what did Dan say about rereading every note?",
    expectedTerms: ["rereading", "note"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core"
  },
  {
    name: "speaker_alias_memory",
    query: "what did Dan say about SXSW?",
    expectedTerms: ["SXSW", "Austin"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core"
  },
  {
    name: "speaker_alias_austin",
    query: "what did Dan say about Austin?",
    expectedTerms: ["fallback", "do not live there now"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core"
  },
  {
    name: "transcript_correction_chain",
    query: "what did Steve say about the Turkey conference?",
    expectedTerms: ["Izmir"],
    expectedExcludes: ["Istanbul", "Ankara"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core"
  },
  {
    name: "relative_last_weekend",
    query: "what did Steve do last weekend?",
    referenceNow: "2026-04-06T12:00:00Z",
    expectedTerms: ["Yellow", "karaoke"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical",
    expectedRankingKernel: "sql_hybrid_core"
  },
  {
    name: "semantic_anchor_after_trip",
    query: "what happened after the Turkey trip?",
    referenceNow: "2026-04-20T12:00:00Z",
    expectedTerms: ["Yellow", "debriefed"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical"
  },
  {
    name: "semantic_anchor_night_met_dan",
    query: "where did Steve go the night he met Dan?",
    expectedTerms: ["Night Noodle Alley", "Dan"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical"
  },
  {
    name: "uncle_clarification",
    query: "who is Uncle?",
    expectedTerms: [],
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications"
  },
  {
    name: "summer_cabin_clarification",
    query: "where was the summer cabin?",
    expectedTerms: [],
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications"
  },
  {
    name: "subject_bound_profile_positive",
    query: "What field is Maya Serra likely to pursue in her education?",
    expectedTerms: ["psychology", "counseling"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical"
  },
  {
    name: "subject_bound_profile_guardrail",
    query: "What field is Leo Navarro likely to pursue in his education?",
    expectedTerms: [],
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications"
  },
  {
    name: "unsupported_shared_overlap_guardrail",
    query: "What do Nina and Omar both do to relax?",
    expectedTerms: [],
    minimumConfidence: "missing"
  },
  {
    name: "project_supersession_reason",
    query: "Why did Project Atlas change direction?",
    expectedTerms: ["sync failures", "offline first", "prevent data loss"],
    minimumConfidence: "confident",
    expectedRetrievalMode: "lexical"
  }
];

async function runScaleQuery(namespaceId: string, spec: ScaleQuerySpec): Promise<ScaleQueryResult> {
  const start = performance.now();
  const result = await searchMemory({
    namespaceId,
    query: spec.query,
    referenceNow: spec.referenceNow,
    limit: 8
  });
  const latencyMs = Number((performance.now() - start).toFixed(2));
  const joined = result.results.map((item) => item.content).join("\n").toLowerCase();
  const confidence = result.meta.answerAssessment?.confidence ?? "missing";
  const retrievalMode = typeof result.meta.retrievalMode === "string" ? result.meta.retrievalMode : null;
  const rankingKernel = typeof result.meta.rankingKernel === "string" ? result.meta.rankingKernel : null;
  const vectorFallbackReason = typeof result.meta.vectorFallbackReason === "string" ? result.meta.vectorFallbackReason : null;
  const lexicalCandidateCount =
    typeof result.meta.lexicalCandidateCount === "number" ? result.meta.lexicalCandidateCount : null;
  const boundedEventSupportCount =
    typeof result.meta.boundedEventSupportCount === "number" ? result.meta.boundedEventSupportCount : null;
  const failures: string[] = [];

  for (const expected of spec.expectedTerms) {
    if (!joined.includes(expected.toLowerCase()) && !String(result.duality.claim.text ?? "").toLowerCase().includes(expected.toLowerCase())) {
      failures.push(`missing term ${expected}`);
    }
  }

  for (const excluded of spec.expectedExcludes ?? []) {
    if (joined.includes(excluded.toLowerCase()) || String(result.duality.claim.text ?? "").toLowerCase().includes(excluded.toLowerCase())) {
      failures.push(`unexpected term ${excluded}`);
    }
  }

  if (confidenceRank(confidence) < confidenceRank(spec.minimumConfidence)) {
    failures.push(`confidence ${confidence} below ${spec.minimumConfidence}`);
  }

  if (spec.expectedFollowUpAction && result.meta.followUpAction !== spec.expectedFollowUpAction) {
    failures.push(`expected follow-up action ${spec.expectedFollowUpAction}, got ${result.meta.followUpAction ?? "none"}`);
  }

  if (spec.expectedRetrievalMode && retrievalMode !== spec.expectedRetrievalMode) {
    failures.push(`expected retrieval mode ${spec.expectedRetrievalMode}, got ${retrievalMode ?? "none"}`);
  }

  if (spec.expectedRankingKernel && rankingKernel !== spec.expectedRankingKernel) {
    failures.push(`expected ranking kernel ${spec.expectedRankingKernel}, got ${rankingKernel ?? "none"}`);
  }

  if (spec.expectedVectorFallbackReason && vectorFallbackReason !== spec.expectedVectorFallbackReason) {
    failures.push(`expected vector fallback reason ${spec.expectedVectorFallbackReason}, got ${vectorFallbackReason ?? "none"}`);
  }

  if (typeof spec.maxLexicalCandidateCount === "number" && typeof lexicalCandidateCount === "number" && lexicalCandidateCount > spec.maxLexicalCandidateCount) {
    failures.push(`lexical candidate count ${lexicalCandidateCount} exceeded ${spec.maxLexicalCandidateCount}`);
  }

  if (typeof spec.maxBoundedEventSupportCount === "number" && typeof boundedEventSupportCount === "number" && boundedEventSupportCount > spec.maxBoundedEventSupportCount) {
    failures.push(`bounded event support count ${boundedEventSupportCount} exceeded ${spec.maxBoundedEventSupportCount}`);
  }

  if (spec.expectedFollowUpAction === "route_to_clarifications") {
    const toolName = result.duality.clarificationHint?.mcpTool?.name ?? result.meta.clarificationHint?.mcpTool?.name;
    if (toolName !== "memory.get_clarifications") {
      failures.push(`expected clarification tool memory.get_clarifications, got ${toolName ?? "none"}`);
    }
  }

  return {
    name: spec.name,
    query: spec.query,
    latencyMs,
    confidence,
    followUpAction: result.meta.followUpAction ?? null,
    retrievalMode,
    rankingKernel,
    vectorFallbackReason,
    lexicalCandidateCount,
    boundedEventSupportCount,
    passed: failures.length === 0,
    failures
  };
}

async function clarificationCounts(namespaceId: string): Promise<Record<string, number>> {
  const rows = await queryRows<{ ambiguity_type: string | null; total: string }>(
    `
      SELECT ambiguity_type, COUNT(*)::text AS total
      FROM claim_candidates
      WHERE namespace_id = $1
        AND ambiguity_state = 'requires_clarification'
      GROUP BY ambiguity_type
      ORDER BY ambiguity_type
    `,
    [namespaceId]
  );
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.ambiguity_type ?? "unknown"] = Number(row.total);
  }
  return result;
}

async function archivalCounts(
  namespaceId: string
): Promise<{ readonly semantic: Record<string, number>; readonly temporal: Record<string, number> }> {
  const semanticRows = await queryRows<{ tier: string; total: string }>(
    `
      SELECT coalesce(metadata->>'archival_tier', 'unset') AS tier, count(*)::text AS total
      FROM semantic_memory
      WHERE namespace_id = $1
      GROUP BY 1
    `,
    [namespaceId]
  );
  const temporalRows = await queryRows<{ tier: string; total: string }>(
    `
      SELECT archival_tier::text AS tier, count(*)::text AS total
      FROM temporal_nodes
      WHERE namespace_id = $1
      GROUP BY 1
    `,
    [namespaceId]
  );

  return {
    semantic: Object.fromEntries(semanticRows.map((row) => [row.tier, Number(row.total)])),
    temporal: Object.fromEntries(temporalRows.map((row) => [row.tier, Number(row.total)]))
  };
}

async function runGraphStress(namespaceId: string): Promise<readonly ScaleGraphResult[]> {
  const steveGraph = await getOpsRelationshipGraph(namespaceId, {
    entityName: "Steve Tietze",
    limit: 160
  });

  const names = new Set(steveGraph.nodes.map((node) => node.name));
  const nodeText = steveGraph.nodes.map((node) => node.name).join("\n");
  const predicates = new Set(steveGraph.edges.map((edge) => edge.predicate));
  const failures: string[] = [];
  for (const term of ["Chiang Mai", "Thailand", "Lake Tahoe", "Two-Way", "Dan", "Lauren"]) {
    if (!names.has(term) && !nodeText.includes(term)) {
      failures.push(`missing node ${term}`);
    }
  }
  if ([...names].some((name) => /^speaker(?:[_\s]+\d+)?$/iu.test(name) || /^speaker[_-]?\d+/iu.test(name))) {
    failures.push("speaker-label leakage reached the scale graph");
  }
  for (const predicate of ["contained_in", "resides_at", "worked_at", "friend_of", "participated_in"]) {
    if (!predicates.has(predicate)) {
      failures.push(`missing edge predicate ${predicate}`);
    }
  }
  if (steveGraph.nodes.length < 20) {
    failures.push(`node count too low: ${steveGraph.nodes.length}`);
  }
  if (steveGraph.edges.length < 20) {
    failures.push(`edge count too low: ${steveGraph.edges.length}`);
  }

  return [
    {
      name: "steve_focus_scale_graph",
      passed: failures.length === 0,
      nodeCount: steveGraph.nodes.length,
      edgeCount: steveGraph.edges.length,
      failures
    }
  ];
}

function toMarkdown(report: LifeScaleBenchmarkReport): string {
  const lines = [
    "# Life Scale Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Generated artifacts: ${report.generatedArtifacts.total} (medium=${report.generatedArtifacts.medium}, large=${report.generatedArtifacts.large}, noisy=${report.generatedArtifacts.noisy}, transcripts=${report.generatedArtifacts.transcripts}, holdout=${report.generatedArtifacts.holdout}, transcriptCorrectionPasses=${report.generatedArtifacts.transcriptCorrectionPasses})`,
    `Baseline quality: confident=${report.baseline.confidentCount}, weak=${report.baseline.weakCount}, missing=${report.baseline.missingCount}`,
    `Baseline pack: confident=${report.baseline.pack.confidentCount}, weak=${report.baseline.pack.weakCount}, missing=${report.baseline.pack.missingCount}`,
    `Scale quality: confident=${report.quality.confidentCount}, weak=${report.quality.weakCount}, missing=${report.quality.missingCount}`,
    `Latency p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms max=${report.latency.maxMs}ms`,
    `Passed: ${report.passed}`,
    "",
    "## Query Results",
    ""
  ];

  for (const item of report.queryResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | confidence=${item.confidence} | latency=${item.latencyMs}ms | mode=${item.retrievalMode ?? "unknown"} | kernel=${item.rankingKernel ?? "unknown"} | lexicalCandidates=${item.lexicalCandidateCount ?? "n/a"}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Graph Results", "");
  for (const item of report.graphResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | nodes=${item.nodeCount} | edges=${item.edgeCount}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Clarifications", "", `\`${JSON.stringify(report.clarificationCounts, null, 2)}\``);
  lines.push("", "## Archival", "", `semantic=${JSON.stringify(report.archivalCounts.semantic)}`, `temporal=${JSON.stringify(report.archivalCounts.temporal)}`);
  return `${lines.join("\n")}\n`;
}

export async function runLifeScaleBenchmark(): Promise<LifeScaleBenchmarkReport> {
  return withMaintenanceLock("the life scale benchmark", async () => {
    const namespaceId = "personal";
    await runMigrations();
    const baseline = await runLifeReplayBenchmark();
    const baselineQueryResults: ScaleQueryResult[] = [];
    for (const spec of SCALE_QUERY_SPECS) {
      baselineQueryResults.push(await runScaleQuery(namespaceId, spec));
    }

    await resetDatabase();
    await seedNamespace(namespaceId);
    const generated = await writeGeneratedArtifacts();
    await ingestGeneratedArtifacts(namespaceId, [
      ...generated.medium,
      ...generated.large,
      ...generated.noisy,
      ...generated.transcripts,
      ...generated.holdout
    ]);
    const transcriptCorrectionPasses = await runTranscriptCorrectionChains(namespaceId);
    await rebuildNamespace(namespaceId);
    await analyzeScaleTables();

    const queryResults: ScaleQueryResult[] = [];
    for (const spec of SCALE_QUERY_SPECS) {
      queryResults.push(await runScaleQuery(namespaceId, spec));
    }

    const graphResults = await runGraphStress(namespaceId);
    const clarifications = await clarificationCounts(namespaceId);
    const archival = await archivalCounts(namespaceId);
    const latencies = queryResults.map((item) => item.latencyMs);
    const confidentCount = queryResults.filter((item) => item.confidence === "confident").length;
    const weakCount = queryResults.filter((item) => item.confidence === "weak").length;
    const missingCount = queryResults.filter((item) => item.confidence === "missing").length;

    return {
      generatedAt: new Date().toISOString(),
      namespaceId,
      baseline: {
        confidentCount: baseline.confidentCount,
        weakCount: baseline.weakCount,
        missingCount: baseline.missingCount,
        passed: baseline.passed,
        pack: {
          confidentCount: baselineQueryResults.filter((item) => item.confidence === "confident").length,
          weakCount: baselineQueryResults.filter((item) => item.confidence === "weak").length,
          missingCount: baselineQueryResults.filter((item) => item.confidence === "missing").length
        }
      },
      generatedArtifacts: {
        medium: generated.medium.length,
        large: generated.large.length,
        noisy: generated.noisy.length,
        transcripts: generated.transcripts.length,
        holdout: generated.holdout.length,
        transcriptCorrectionPasses,
        total:
          generated.medium.length +
          generated.large.length +
          generated.noisy.length +
          generated.transcripts.length +
          generated.holdout.length
      },
      clarificationCounts: clarifications,
      archivalCounts: archival,
      graphResults,
      queryResults,
      latency: {
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        maxMs: percentile(latencies, 100)
      },
      quality: {
        confidentCount,
        weakCount,
        missingCount
      },
      qualityDelta: {
        confidentDelta: confidentCount - baselineQueryResults.filter((item) => item.confidence === "confident").length,
        weakDelta: weakCount - baselineQueryResults.filter((item) => item.confidence === "weak").length,
        missingDelta: missingCount - baselineQueryResults.filter((item) => item.confidence === "missing").length
      },
      passed: [...queryResults, ...graphResults].every((item) => item.passed)
    };
  });
}

export async function runAndWriteLifeScaleBenchmark(): Promise<{
  readonly report: LifeScaleBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runLifeScaleBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `life-scale-${stamp}.json`);
    const markdownPath = path.join(dir, `life-scale-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    await writeFile(path.join(dir, "life-scale-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(dir, "life-scale-latest.md"), toMarkdown(report), "utf8");
    return {
      report,
      output: {
        jsonPath,
        markdownPath
      }
    };
  } finally {
    await closePool();
  }
}
