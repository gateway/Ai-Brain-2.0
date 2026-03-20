import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withMaintenanceLock, withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runUniversalMutableReconsolidation, runMemoryReconsolidation } from "../jobs/memory-reconsolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { getOpsRelationshipGraph, getOpsTimelineView } from "../ops/service.js";
import { executeDerivationWorker } from "../ops/runtime-worker-service.js";
import { runSemanticDecay } from "../jobs/semantic-decay.js";
import { runTemporalNodeArchival, runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { enqueueDerivationJob } from "../jobs/derivation-queue.js";
import { searchMemory } from "../retrieval/service.js";
import type { RecallConfidenceGrade } from "../retrieval/types.js";
import type { RecallResult, SourceType } from "../types.js";

interface ReplayFixture {
  readonly path: string;
  readonly sourceType: SourceType;
  readonly sourceChannel: string;
  readonly capturedAt: string;
}

interface GeneratedReplayFixture extends ReplayFixture {
  readonly contents: string | Uint8Array;
  readonly derivation?: {
    readonly manualContentText: string;
    readonly jobKind?: "ocr" | "transcription" | "caption" | "summary" | "derive_text" | "embed";
    readonly modality?: "image" | "pdf" | "audio" | "video" | "text";
    readonly metadata?: Record<string, unknown>;
  };
}

interface ReplayQueryExpectation {
  readonly name: string;
  readonly query: string;
  readonly expectTopTypes?: readonly RecallResult["memoryType"][];
  readonly expectTopIncludes: readonly string[];
  readonly expectExcludes?: readonly string[];
  readonly expectedDualityClaimIncludes?: readonly string[];
  readonly requireEvidence?: boolean;
  readonly requireDuality?: boolean;
  readonly minimumConfidence?: RecallConfidenceGrade;
  readonly expectNoResults?: boolean;
  readonly expectedFollowUpAction?: "none" | "suggest_verification" | "route_to_clarifications";
  readonly beforeReconsolidationQuery?: string;
  readonly expectedPlannerQueryClass?: "direct_fact" | "temporal_summary" | "temporal_detail" | "causal" | "graph_multi_hop";
  readonly expectedLeafEvidenceRequired?: boolean;
  readonly expectedTemporalGateTriggered?: boolean;
  readonly expectedTemporalSummarySufficient?: boolean;
  readonly expectedClarificationToolName?: string;
}

interface ReplayStateExpectation {
  readonly name: string;
  readonly sql: string;
  readonly expectIncludes: readonly string[];
  readonly expectExcludes?: readonly string[];
}

interface ReplayQueryResult {
  readonly name: string;
  readonly query: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly confidence: RecallConfidenceGrade;
  readonly confidenceReason: string;
  readonly dualityPresent: boolean;
  readonly evidenceCount: number;
  readonly directEvidence: boolean;
}

interface ReplayStateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface ReplayGraphExpectation {
  readonly name: string;
  readonly entityName: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly expectNodeIncludes: readonly string[];
  readonly expectEdgePredicates?: readonly string[];
}

interface ReplayGraphResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

interface ReplayOpsResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface LifeReplayBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly resetDatabase: boolean;
  readonly seededArtifacts: number;
  readonly queryResults: readonly ReplayQueryResult[];
  readonly stateResults: readonly ReplayStateResult[];
  readonly graphResults: readonly ReplayGraphResult[];
  readonly opsResults: readonly ReplayOpsResult[];
  readonly confidentCount: number;
  readonly weakCount: number;
  readonly missingCount: number;
  readonly passed: boolean;
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

function replayFixtureRoot(): string {
  return process.env.BRAIN_LIFE_REPLAY_FIXTURE_ROOT?.trim()
    ? path.resolve(process.env.BRAIN_LIFE_REPLAY_FIXTURE_ROOT)
    : path.resolve(rootDir(), "examples-private", "life-replay");
}

function replayFixturePath(fileName: string): string {
  return path.resolve(replayFixtureRoot(), fileName);
}

function generatedFixtureRoot(): string {
  return path.resolve(rootDir(), "benchmark-generated", "life-replay");
}

async function ensureGeneratedFixtures(): Promise<readonly GeneratedReplayFixture[]> {
  const dir = generatedFixtureRoot();
  await mkdir(dir, { recursive: true });

  const fixtures: readonly GeneratedReplayFixture[] = [
    {
      path: path.join(dir, "clarification-protocol-1.md"),
      sourceType: "markdown",
      sourceChannel: "life-replay:clarification-heuristic-1",
      capturedAt: "2026-03-24T09:00:00Z",
      contents:
        "If we do not know who Uncle is, ask for clarification instead of guessing. Unknown identity should route to the clarifications inbox instead of polluting the graph.\n"
    },
    {
      path: path.join(dir, "clarification-protocol-2.md"),
      sourceType: "markdown",
      sourceChannel: "life-replay:clarification-heuristic-2",
      capturedAt: "2026-03-31T09:00:00Z",
      contents:
        "When identity or grounding is unclear, the brain should ask for clarification instead of guessing. That applies to kinship terms and vague places.\n"
    },
    {
      path: path.join(dir, "clarification-protocol-3.md"),
      sourceType: "markdown",
      sourceChannel: "life-replay:clarification-heuristic-3",
      capturedAt: "2026-04-07T09:00:00Z",
      contents:
        "Operational rule: unknown identity or vague place references should never be guessed. Ask for clarification instead of guessing and keep the answer explicit.\n"
    },
    {
      path: path.join(dir, "march-redesign-whiteboard.png"),
      sourceType: "image",
      sourceChannel: "life-replay:whiteboard-photo",
      capturedAt: "2026-03-14T10:30:00Z",
      contents: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x72, 0x61, 0x69, 0x6e]),
      derivation: {
        manualContentText:
          "Whiteboard photo from the March redesign packet. Notes say: port 8787, keep Steve centered, expand Chiang Mai to Thailand, and use parent_entity_id for place hierarchy.",
        jobKind: "ocr",
        modality: "image",
        metadata: {
          derivation_source: "benchmark_multimodal_fixture",
          fixture_kind: "whiteboard_photo"
        }
      }
    },
    {
      path: path.join(dir, "march-redesign-packet.pdf"),
      sourceType: "pdf",
      sourceChannel: "life-replay:redesign-packet",
      capturedAt: "2026-03-14T10:31:00Z",
      contents: Buffer.from("%PDF-1.4\n%AI Brain replay packet\n", "utf8"),
      derivation: {
        manualContentText:
          "March redesign packet says the Steve graph should expand through home, work, friends, and place hierarchy with evidence-backed edges and ground-truth source links.",
        jobKind: "ocr",
        modality: "pdf",
        metadata: {
          derivation_source: "benchmark_multimodal_fixture",
          fixture_kind: "redesign_packet"
        }
      }
    },
    {
      path: path.join(dir, "chiang-mai-graph-voice-memo.mp3"),
      sourceType: "audio",
      sourceChannel: "life-replay:graph-voice-memo",
      capturedAt: "2026-03-15T08:00:00Z",
      contents: Buffer.from("ID3AI Brain voice memo", "utf8"),
      derivation: {
        manualContentText:
          "Voice memo says the graph should expand from Steve to Chiang Mai to Thailand, from Steve to Two-Way, and from Steve to Dan, Lauren, and Ben with provenance on every edge.",
        jobKind: "transcription",
        modality: "audio",
        metadata: {
          derivation_source: "benchmark_multimodal_fixture",
          fixture_kind: "graph_voice_memo"
        }
      }
    }
  ];

  for (const fixture of fixtures) {
    await writeFile(fixture.path, fixture.contents);
  }

  return fixtures;
}

const FIXTURES: readonly ReplayFixture[] = [
  {
    path: replayFixturePath("work-history.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:work-history",
    capturedAt: "2026-03-18T09:00:00Z"
  },
  {
    path: replayFixturePath("location-history.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:location-history",
    capturedAt: "2026-03-18T10:00:00Z"
  },
  {
    path: replayFixturePath("friends-and-preferences.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:friends",
    capturedAt: "2026-03-18T11:00:00Z"
  },
  {
    path: replayFixturePath("relationship-history.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:relationship",
    capturedAt: "2026-03-19T08:00:00Z"
  },
  {
    path: replayFixturePath("social-circle.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:social-circle",
    capturedAt: "2026-03-18T12:00:00Z"
  },
  {
    path: replayFixturePath("current-project.md"),
    sourceType: "project_note",
    sourceChannel: "life-replay:project",
    capturedAt: "2026-03-18T13:00:00Z"
  },
  {
    path: replayFixturePath("movies-and-watchlist.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:movies",
    capturedAt: "2026-03-19T09:00:00Z"
  },
  {
    path: replayFixturePath("daily-life.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:daily-life",
    capturedAt: "2026-03-20T10:00:00Z"
  },
  {
    path: replayFixturePath("preference-supersession.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:supersession",
    capturedAt: "2026-03-19T11:00:00Z"
  },
  {
    path: replayFixturePath("coffee-preference-2024.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:coffee-preference-2024",
    capturedAt: "2024-06-01T09:00:00Z"
  },
  {
    path: replayFixturePath("coffee-preference-2026.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:coffee-preference-2026",
    capturedAt: "2026-02-01T09:00:00Z"
  },
  {
    path: replayFixturePath("belief-infrastructure-2025.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:belief-infrastructure-2025",
    capturedAt: "2025-01-10T09:00:00Z"
  },
  {
    path: replayFixturePath("belief-infrastructure-2026.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:belief-infrastructure-2026",
    capturedAt: "2026-02-10T09:00:00Z"
  },
  {
    path: replayFixturePath("alex-current-dating.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:alex-current-dating",
    capturedAt: "2026-03-01T09:00:00Z"
  },
  {
    path: replayFixturePath("alex-contact-paused.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:alex-contact-paused",
    capturedAt: "2026-03-05T09:00:00Z"
  },
  {
    path: replayFixturePath("alex-reconnected.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:alex-reconnected",
    capturedAt: "2026-03-10T09:00:00Z"
  },
  {
    path: replayFixturePath("nina-current-dating.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:nina-current-dating",
    capturedAt: "2026-01-01T09:00:00Z"
  },
  {
    path: replayFixturePath("nina-breakup.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:nina-breakup",
    capturedAt: "2026-02-01T09:00:00Z"
  },
  {
    path: replayFixturePath("salience-frustration.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:salience-frustration",
    capturedAt: "2026-03-21T09:00:00Z"
  },
  {
    path: replayFixturePath("salience-surprise.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:salience-surprise",
    capturedAt: "2026-03-22T09:00:00Z"
  },
  {
    path: replayFixturePath("salience-excitement.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:salience-excitement",
    capturedAt: "2026-03-23T09:00:00Z"
  },
  {
    path: replayFixturePath("current-employer.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:current-employer",
    capturedAt: "2026-03-19T11:30:00Z"
  },
  {
    path: replayFixturePath("residence-koh-samui.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:residence-tenure-koh-samui",
    capturedAt: "2025-01-10T00:00:00Z"
  },
  {
    path: replayFixturePath("residence-chiang-mai.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:residence-tenure-chiang-mai",
    capturedAt: "2025-07-15T00:00:00Z"
  },
  {
    path: replayFixturePath("employer-well-inked.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:employer-tenure-well-inked",
    capturedAt: "2026-01-15T00:00:00Z"
  },
  {
    path: replayFixturePath("employer-two-way.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:employer-tenure-two-way",
    capturedAt: "2026-03-12T00:00:00Z"
  },
  {
    path: replayFixturePath("photo-club-mention.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:photo-club-mention",
    capturedAt: "2026-03-01T10:00:00Z"
  },
  {
    path: replayFixturePath("photo-club-session-1.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:photo-club-1",
    capturedAt: "2026-03-08T10:00:00Z"
  },
  {
    path: replayFixturePath("photo-club-session-2.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:photo-club-2",
    capturedAt: "2026-03-15T19:00:00Z"
  },
  {
    path: replayFixturePath("photo-club-session-3.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:photo-club-3",
    capturedAt: "2026-03-22T19:00:00Z"
  },
  {
    path: replayFixturePath("decisions-and-constraints.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:decisions-constraints",
    capturedAt: "2026-03-19T12:00:00Z"
  },
  {
    path: replayFixturePath("event-context.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:event-context",
    capturedAt: "2026-03-20T12:00:00Z"
  },
  {
    path: replayFixturePath("coworking-cost.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:event-cost",
    capturedAt: "2026-03-20T12:15:00Z"
  },
  {
    path: replayFixturePath("routine-week-1.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:routine-1",
    capturedAt: "2026-03-03T03:00:00Z"
  },
  {
    path: replayFixturePath("routine-week-2.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:routine-2",
    capturedAt: "2026-03-10T03:00:00Z"
  },
  {
    path: replayFixturePath("routine-week-3.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:routine-3",
    capturedAt: "2026-03-17T03:00:00Z"
  },
  {
    path: replayFixturePath("style-specs-1.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:style-specs-1",
    capturedAt: "2026-03-18T14:00:00Z"
  },
  {
    path: replayFixturePath("style-specs-2.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:style-specs-2",
    capturedAt: "2026-03-19T14:00:00Z"
  },
  {
    path: replayFixturePath("style-specs-3.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:style-specs-3",
    capturedAt: "2026-03-20T14:00:00Z"
  },
  {
    path: replayFixturePath("replay-integrity-1.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:replay-integrity-1",
    capturedAt: "2026-03-21T14:00:00Z"
  },
  {
    path: replayFixturePath("replay-integrity-2.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:replay-integrity-2",
    capturedAt: "2026-03-22T14:00:00Z"
  },
  {
    path: replayFixturePath("dietary-blocker-peanuts.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:dietary-blocker-peanuts",
    capturedAt: "2024-07-14T09:00:00Z"
  },
  {
    path: replayFixturePath("python-workers-2025.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:python-workers-2025",
    capturedAt: "2025-03-14T09:00:00Z"
  },
  {
    path: replayFixturePath("python-workers-2026.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:python-workers-2026",
    capturedAt: "2026-02-14T09:00:00Z"
  },
  {
    path: replayFixturePath("pdf-protocol-1.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:pdf-protocol-1",
    capturedAt: "2026-01-05T09:00:00Z"
  },
  {
    path: replayFixturePath("pdf-protocol-2.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:pdf-protocol-2",
    capturedAt: "2026-01-19T09:00:00Z"
  },
  {
    path: replayFixturePath("pdf-protocol-3.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:pdf-protocol-3",
    capturedAt: "2026-02-02T09:00:00Z"
  },
  {
    path: replayFixturePath("uncle-ambiguity.md"),
    sourceType: "markdown",
    sourceChannel: "life-replay:uncle-ambiguity",
    capturedAt: "2026-03-18T15:00:00Z"
  }
];

const QUERY_EXPECTATIONS: readonly ReplayQueryExpectation[] = [
  {
    name: "born_query",
    query: "where was Steve born?",
    expectTopIncludes: ["Munich"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "current_home_query",
    query: "where does Steve live?",
    expectTopIncludes: ["Chiang Mai"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "historical_home_query",
    query: "where has Steve lived?",
    expectTopIncludes: ["Lake Tahoe", "Kansas"],
    requireEvidence: true
  },
  {
    name: "friends_query",
    query: "who are Steve's friends?",
    expectTopIncludes: ["Dan", "Ben", "Lauren"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "work_history_query",
    query: "where has Steve worked?",
    expectTopIncludes: ["Apogee Software", "Factor 5", "Likemoji"],
    requireEvidence: true
  },
  {
    name: "current_employer_query",
    query: "where does Steve work?",
    expectTopIncludes: ["Two-Way"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "why_current_employer_query",
    query: "why does the brain believe Steve works at Two-Way?",
    expectTopIncludes: ["Two-Way"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "causal",
    expectedLeafEvidenceRequired: true
  },
  {
    name: "lauren_locations_query",
    query: "where did Lauren live?",
    expectTopIncludes: ["Tahoe City", "Bend", "Koh Samui", "Chiang Mai"],
    requireEvidence: true
  },
  {
    name: "lauren_relationship_history_query",
    query: "did Steve and Lauren date?",
    expectTopIncludes: ["Steve", "Lauren", "dated"],
    requireEvidence: true
  },
  {
    name: "dating_history_query",
    query: "who was Steve dating?",
    expectTopIncludes: ["Lauren", "dated"],
    requireEvidence: true
  },
  {
    name: "dating_current_query",
    query: "who is Steve dating now?",
    expectTopIncludes: [],
    expectedDualityClaimIncludes: ["Unknown."],
    requireEvidence: true,
    requireDuality: true,
    minimumConfidence: "confident",
    expectedFollowUpAction: "none"
  },
  {
    name: "alex_current_partner_query",
    query: "who is Alex dating now?",
    expectTopIncludes: ["Sam"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "nina_historical_partner_query",
    query: "who was Nina dating?",
    expectTopIncludes: ["Omar"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "nina_current_partner_query",
    query: "who is Nina dating now?",
    expectTopIncludes: [],
    expectedDualityClaimIncludes: ["Unknown."],
    requireEvidence: true,
    requireDuality: true,
    minimumConfidence: "confident",
    expectedFollowUpAction: "none",
    beforeReconsolidationQuery: "check Nina's profile summary for consistency."
  },
  {
    name: "lauren_breakup_history_query",
    query: "did Steve and Lauren break up?",
    expectTopIncludes: ["Steve", "Lauren", "broke up"],
    requireEvidence: true
  },
  {
    name: "lauren_reconnection_history_query",
    query: "did Steve and Lauren start talking again?",
    expectTopIncludes: ["Steve", "Lauren", "started talking again"],
    requireEvidence: true
  },
  {
    name: "current_project_query",
    query: "what is Steve working on?",
    expectTopIncludes: ["Two-Way"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "why_current_home_query",
    query: "why does the brain believe Steve lives in Chiang Mai?",
    expectTopIncludes: ["Chiang Mai"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "photo_club_membership_query",
    query: "what groups is Steve a member of?",
    expectTopIncludes: ["Photo Club"],
    requireEvidence: true
  },
  {
    name: "favorite_movies_query",
    query: "what movies does Steve like?",
    expectTopIncludes: ["Inception", "Sinners", "Trainspotting"],
    requireEvidence: true
  },
  {
    name: "favorite_activities_query",
    query: "what activities does Steve like?",
    expectTopIncludes: ["Snowboarding", "Hiking"],
    requireEvidence: true
  },
  {
    name: "skills_query",
    query: "what skills does Steve have?",
    expectTopIncludes: ["Full-Stack Web Development", "Photogrammetry", "Stable Diffusion"],
    requireEvidence: true
  },
  {
    name: "watchlist_query",
    query: "what does Steve want to watch?",
    expectTopIncludes: ["Weapons", "Avatar"],
    requireEvidence: true
  },
  {
    name: "current_coffee_preference_query",
    query: "what does Steve prefer now for coffee?",
    expectTopIncludes: ["pour-over coffee"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "historical_coffee_preference_query",
    query: "what did Steve use to prefer for coffee?",
    expectTopIncludes: ["espresso coffee"],
    expectExcludes: ["pour-over coffee"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "point_in_time_coffee_preference_query",
    query: "what did Steve prefer in 2024 for coffee?",
    expectTopIncludes: ["espresso coffee"],
    expectExcludes: ["pour-over coffee"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "decisions_query",
    query: "what decisions has Steve made?",
    expectTopIncludes: ["Thailand", "Postgres"],
    requireEvidence: true
  },
  {
    name: "postgres_decision_query",
    query: "why do we use Postgres?",
    expectTopIncludes: ["Postgres"],
    requireEvidence: true,
    expectedPlannerQueryClass: "causal",
    expectedLeafEvidenceRequired: true
  },
  {
    name: "constraints_query",
    query: "what constraints does the brain follow?",
    expectTopIncludes: ["ground-truth", "rewrite raw source truth", "clarification"],
    requireEvidence: true
  },
  {
    name: "style_specs_query",
    query: "what style specs does Steve have?",
    expectTopIncludes: ["concise", "NotebookLM", "natural-language queryability"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "response_style_query",
    query: "what is Steve's preferred response style?",
    expectTopIncludes: ["concise"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "ontology_protocol_query",
    query: "what is the mandatory protocol for changing the brain's ontology?",
    expectTopIncludes: ["NotebookLM"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "db_replay_protocol_query",
    query: "what should be done with the database after each ontology slice?",
    expectTopIncludes: ["replay", "database"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "operational_protocol_query",
    query: "what is the mandatory protocol for maintaining database integrity after an implementation slice?",
    expectTopIncludes: ["wipe", "replay", "database"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "current_goal_query",
    query: "what is Steve's current primary goal?",
    expectTopIncludes: ["Thailand"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "turkey_plan_query",
    query: "what plans do we have for the Turkey conference?",
    expectTopIncludes: ["Turkey", "conference", "Two-Way"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "current_belief_query",
    query: "what is Steve's current stance on infrastructure?",
    expectTopIncludes: ["local-first", "Qwen", "infrastructure"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "historical_belief_query",
    query: "how has Steve's opinion on infrastructure changed since 2025?",
    expectTopIncludes: ["hosted", "local-first", "infrastructure"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "point_in_time_belief_query",
    query: "did Steve still support hosted infrastructure in January 2025?",
    expectTopIncludes: ["hosted", "infrastructure"],
    expectExcludes: ["local-first"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "salience_surprise_query",
    query: "what was Steve's most surprising realization during the local-brain bring-up?",
    expectTopIncludes: ["claim-plus-evidence", "embeddings", "surprising"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "salience_frustration_query",
    query: "what was the most frustrating part of the local-brain bring-up?",
    expectTopIncludes: ["PostgreSQL", "parameter binding bug", "frustrating"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "salience_excitement_query",
    query: "what was Steve excited about with the graph UX?",
    expectTopIncludes: ["graph UX", "places", "friends"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "routines_query",
    query: "what routines does Steve have?",
    expectTopIncludes: ["Tuesday coworking at Yellow co-working space"],
    requireEvidence: true
  },
  {
    name: "dinner_companion_query",
    query: "who did Steve have dinner with?",
    expectTopIncludes: ["Dan"],
    requireEvidence: true
  },
  {
    name: "coworking_location_query",
    query: "where did Steve go coworking?",
    expectTopIncludes: ["Yellow"],
    requireEvidence: true
  },
  {
    name: "day_summary_query_initial",
    query: "what did Steve do on March 20 2026?",
    expectTopTypes: ["temporal_nodes"],
    expectTopIncludes: ["Coworking", "Massage", "Dinner"],
    requireEvidence: true,
    expectedPlannerQueryClass: "temporal_summary",
    expectedLeafEvidenceRequired: false
  },
  {
    name: "day_summary_query_reconsolidated",
    query: "what did Steve do on March 20 2026?",
    expectTopTypes: ["semantic_memory"],
    expectTopIncludes: ["March 20, 2026", "Coworking", "Massage", "Dinner"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "temporal_summary",
    expectedLeafEvidenceRequired: false,
    expectedTemporalSummarySufficient: true
  },
  {
    name: "temporal_detail_cost_query",
    query: "how much did coworking cost on March 20 2026?",
    expectTopTypes: ["episodic_memory", "narrative_event"],
    expectTopIncludes: ["250 baht", "Yellow"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "temporal_detail",
    expectedLeafEvidenceRequired: true
  },
  {
    name: "yellow_event_query",
    query: "what happened at Yellow co-working space?",
    expectTopIncludes: ["Yellow", "Gummi", "Two-Way"],
    requireEvidence: true
  },
  {
    name: "dinner_event_query",
    query: "what happened during dinner with Dan?",
    expectTopIncludes: ["Dan", "Chiang Mai", "Thailand", "Japan"],
    requireEvidence: true
  },
  {
    name: "dietary_blocker_query",
    query: "what are my absolute dietary blockers for tonight's dinner?",
    expectTopIncludes: ["peanut"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "python_workers_current_belief_query",
    query: "what is my current stance on using Python for high-concurrency jobs?",
    expectTopIncludes: ["rust", "workers"],
    requireEvidence: true,
    minimumConfidence: "confident",
    beforeReconsolidationQuery: "check belief summary for Python high-concurrency jobs for consistency."
  },
  {
    name: "python_workers_historical_belief_query",
    query: "how has my opinion on Python for high-concurrency jobs changed?",
    expectTopIncludes: ["python", "rust"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "postgres_vector_db_why_query",
    query: "why did we decide to use a unified Postgres substrate instead of a dedicated vector database?",
    expectTopIncludes: ["postgres", "vectors", "graph"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "causal",
    expectedLeafEvidenceRequired: true
  },
  {
    name: "pdf_protocol_query",
    query: "what is the mandatory protocol for handling large PDF uploads in this substrate?",
    expectTopIncludes: ["pdf", "50mb", "chunk"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "whiteboard_derivation_query",
    query: "what was written on the whiteboard photo from the March redesign packet?",
    expectTopTypes: ["artifact_derivation"],
    expectTopIncludes: ["port 8787", "parent_entity_id", "Chiang Mai", "Thailand"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "packet_derivation_query",
    query: "what did the March redesign packet say about the Steve graph?",
    expectTopTypes: ["artifact_derivation"],
    expectTopIncludes: ["Steve graph", "friends", "place hierarchy", "source links"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "voice_memo_derivation_query",
    query: "what did the Chiang Mai graph voice memo say?",
    expectTopTypes: ["artifact_derivation"],
    expectTopIncludes: ["Chiang Mai", "Thailand", "Two-Way", "Dan", "Lauren", "Ben"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "chiang_mai_hierarchy_query",
    query: "what country is Chiang Mai in?",
    expectTopTypes: ["relationship_memory"],
    expectTopIncludes: ["Chiang Mai", "Thailand"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "graph_multi_hop",
    expectedLeafEvidenceRequired: false
  },
  {
    name: "tahoe_city_hierarchy_query",
    query: "where in the hierarchy is Tahoe City?",
    expectTopTypes: ["relationship_memory"],
    expectTopIncludes: ["Tahoe City", "Lake Tahoe", "California"],
    requireEvidence: true,
    minimumConfidence: "confident",
    expectedPlannerQueryClass: "graph_multi_hop",
    expectedLeafEvidenceRequired: false
  },
  {
    name: "clarification_constraint_query",
    query: "what constraint should the brain follow when identity is unclear?",
    expectTopIncludes: ["clarification", "guessing"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "uncle_clarification_query",
    query: "who is Uncle?",
    expectTopIncludes: [],
    requireDuality: true,
    minimumConfidence: "missing",
    expectedFollowUpAction: "route_to_clarifications",
    expectedClarificationToolName: "memory.get_clarifications"
  }
];

const GRAPH_EXPECTATIONS: readonly ReplayGraphExpectation[] = [
  {
    name: "steve_focus_graph",
    entityName: "Steve Tietze",
    expectNodeIncludes: ["Yellow co-working space", "Dinner with Dan at Chiang Mai", "Dan", "Two-Way", "Lake Tahoe", "Chiang Mai", "Thailand", "Factor 5", "Lauren"],
    expectEdgePredicates: ["participated_in", "includes", "resides_at", "worked_at", "friend_of", "contained_in"]
  }
];

const OPS_EXPECTATIONS = [
  {
    name: "timeline_overlay_audit",
    timeStart: "2024-01-01T00:00:00Z",
    timeEnd: "2026-12-31T23:59:59Z"
  }
] as const;

const STATE_EXPECTATIONS: readonly ReplayStateExpectation[] = [
  {
    name: "current_home_state",
    sql: `
      SELECT state_value::text AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'current_location'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    expectIncludes: ["Chiang Mai"]
  },
  {
    name: "current_residency_edge",
    sql: `
      SELECT concat(rm.predicate, ' ', object_entity.canonical_name, ' ', coalesce(rm.valid_until::text, 'active')) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'resides_at'
        AND rm.status = 'active'
        AND rm.valid_until IS NULL
      ORDER BY rm.valid_from DESC
    `,
    expectIncludes: ["resides_at Chiang Mai"],
    expectExcludes: ["Thailand", "Koh Samui"]
  },
  {
    name: "temporal_nodes_exist",
    sql: `
      SELECT concat(layer, '|', count(*)::text) AS value
      FROM temporal_nodes
      WHERE namespace_id = 'personal'
      GROUP BY layer
      ORDER BY layer
    `,
    expectIncludes: ["day|", "week|", "month|", "year|"]
  },
  {
    name: "daily_life_events_exist",
    sql: `
      SELECT ne.event_label AS value
      FROM narrative_events ne
      INNER JOIN artifacts a ON a.id = ne.artifact_id
      WHERE ne.namespace_id = 'personal'
        AND a.uri LIKE '%daily-life.md'
      ORDER BY ne.created_at
    `,
    expectIncludes: ["Yellow co-working", "Massage", "Dinner"]
  },
  {
    name: "mac_preference_superseded",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_key IN ('preference:mac', 'preference:openclaw')
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: ["preference:mac", "\"polarity\": \"dislike\"", "preference:openclaw", "\"polarity\": \"like\""]
  },
  {
    name: "mac_preference_has_history",
    sql: `
      SELECT concat(state_key, ' ', coalesce(valid_until::text, 'active'), ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_key = 'preference:mac'
      ORDER BY valid_from
    `,
    expectIncludes: ["\"polarity\": \"like\"", "\"polarity\": \"dislike\""]
  },
  {
    name: "coffee_preference_has_history",
    sql: `
      SELECT concat(state_key, ' ', coalesce(valid_until::text, 'active'), ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'preference'
        AND state_key IN ('preference:espresso coffee', 'preference:pour-over coffee')
      ORDER BY valid_from
    `,
    expectIncludes: ["preference:espresso coffee", "preference:pour-over coffee", "\"polarity\": \"like\"", "\"polarity\": \"dislike\""]
  },
  {
    name: "historical_project_roles_not_active",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'project_role'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: [],
    expectExcludes: ["Apogee Software", "Factor 5", "Likemoji", "TouchFactor", "Rogue Entertainment", "The Samui Experience"]
  },
  {
    name: "active_affiliations_not_polluted",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'active_affiliation'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: ["Tim", "Well Inked"],
    expectExcludes: ["Apogee Software", "Factor 5", "Likemoji", "TouchFactor", "Rogue Entertainment", "The Samui Experience"]
  },
  {
    name: "current_employer_state",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'current_employer'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
    `,
    expectIncludes: ["Steve", "Two-Way"],
    expectExcludes: ["Likemoji", "Factor 5", "The Samui Experience"]
  },
  {
    name: "current_employer_edge",
    sql: `
      SELECT concat(rm.predicate, ' ', object_entity.canonical_name, ' ', coalesce(rm.valid_until::text, 'active')) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'works_at'
        AND rm.status = 'active'
      ORDER BY rm.valid_from DESC
    `,
    expectIncludes: ["works_at Two-Way active"],
    expectExcludes: ["Likemoji", "Factor 5", "TouchFactor", "The Samui Experience"]
  },
  {
    name: "superseded_residency_tenure_chain",
    sql: `
      SELECT concat(
        rm.predicate,
        ' ',
        object_entity.canonical_name,
        ' ',
        coalesce(rm.valid_until::text, 'active'),
        ' ',
        coalesce(rm.superseded_by_id::text, '')
      ) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'resides_at'
      ORDER BY rm.valid_from ASC
    `,
    expectIncludes: ["resides_at Koh Samui", "resides_at Chiang Mai active"],
    expectExcludes: ["resides_at Koh Samui active "]
  },
  {
    name: "superseded_employer_tenure_chain",
    sql: `
      SELECT concat(
        rm.predicate,
        ' ',
        object_entity.canonical_name,
        ' ',
        coalesce(rm.valid_until::text, 'active'),
        ' ',
        coalesce(rm.superseded_by_id::text, '')
      ) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'works_at'
      ORDER BY rm.valid_from ASC
    `,
    expectIncludes: ["works_at Well Inked", "works_at Two-Way active"],
    expectExcludes: ["works_at Well Inked active "]
  },
  {
    name: "historical_work_tenures_exist",
    sql: `
      SELECT concat(rm.predicate, ' ', object_entity.canonical_name) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'worked_at'
      ORDER BY rm.valid_from DESC NULLS LAST, object_entity.canonical_name
    `,
    expectIncludes: ["worked_at Apogee Software", "worked_at Factor 5", "worked_at Likemoji"]
  },
  {
    name: "photo_club_membership_state",
    sql: `
      SELECT concat(rm.predicate, ' ', object_entity.canonical_name) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND rm.predicate = 'member_of'
      ORDER BY rm.valid_from DESC
    `,
    expectIncludes: ["member_of Photo Club"]
  },
  {
    name: "historical_romantic_relationship_not_active",
    sql: `
      SELECT concat(predicate, ' ', coalesce(metadata->>'relationship_kind', ''), ' ', valid_from::text) AS value
      FROM relationship_memory
      WHERE namespace_id = 'personal'
        AND predicate = 'was_with'
        AND status = 'active'
        AND valid_until IS NULL
    `,
    expectIncludes: [],
    expectExcludes: ["romantic"]
  },
  {
    name: "historical_significant_other_exists",
    sql: `
      SELECT concat(rm.predicate, ' ', subject_entity.canonical_name, ' ', object_entity.canonical_name, ' ', rm.valid_from::text, ' ', coalesce(rm.valid_until::text, 'active')) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND rm.predicate = 'significant_other_of'
        AND subject_entity.canonical_name = 'Nina'
        AND object_entity.canonical_name = 'Omar'
    `,
    expectIncludes: ["significant_other_of Nina Omar"]
  },
  {
    name: "alex_current_relationship_state_exists",
    sql: `
      SELECT coalesce(string_agg(state_value::text, ' | ' ORDER BY updated_at DESC), '') AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'current_relationship'
        AND valid_until IS NULL
        AND state_value->>'person' = 'Alex'
    `,
    expectIncludes: ["Alex", "Sam"]
  },
  {
    name: "alex_closed_relationship_tenure_exists",
    sql: `
      SELECT concat(
        coalesce(rm.valid_from::text, ''),
        ' ',
        coalesce(rm.valid_until::text, ''),
        ' ',
        coalesce(rm.superseded_by_id::text, ''),
        ' ',
        coalesce(rm.metadata->>'relationship_transition', '')
      ) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND rm.predicate = 'significant_other_of'
        AND subject_entity.canonical_name = 'Alex'
        AND object_entity.canonical_name = 'Sam'
        AND rm.valid_until IS NOT NULL
      ORDER BY rm.valid_from ASC
    `,
    expectIncludes: ["2026-03-05", "paused"]
  },
  {
    name: "nina_historical_relationship_state_exists",
    sql: `
      SELECT coalesce(string_agg(state_value::text || ' @ ' || coalesce(valid_until::text, ''), ' | ' ORDER BY updated_at DESC), '') AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'current_relationship'
        AND valid_until IS NOT NULL
        AND state_value->>'person' = 'Nina'
    `,
    expectIncludes: ["Nina", "Omar", "2026"]
  },
  {
    name: "nina_current_relationship_state_absent",
    sql: `
      SELECT count(*)::text AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'current_relationship'
        AND valid_until IS NULL
        AND state_value->>'person' = 'Nina'
    `,
    expectIncludes: ["0"]
  },
  {
    name: "activity_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'activity'
      ORDER BY canonical_name
    `,
    expectIncludes: ["activity Hiking", "activity Mountain Sports", "activity Snowboarding"]
  },
  {
    name: "media_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'media'
      ORDER BY canonical_name
    `,
    expectIncludes: ["media Movies", "media Inception", "media Weapons"]
  },
  {
    name: "skill_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'skill'
      ORDER BY canonical_name
    `,
    expectIncludes: ["skill Full-Stack Web Development", "skill Photogrammetry", "skill Stable Diffusion"]
  },
  {
    name: "decision_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'decision'
      ORDER BY canonical_name
    `,
    expectIncludes: ["decision Keep Brain 2.0 on Postgres", "decision Stay in Thailand long term"]
  },
  {
    name: "constraint_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'constraint'
      ORDER BY canonical_name
    `,
    expectIncludes: [
      "constraint Ask For Clarification Instead Of Guessing",
      "constraint Never Silently Rewrite Raw Source Truth",
      "constraint Return Ground-Truth Source Document With Search Results",
      "constraint Peanuts are an absolute dietary blocker for Steve"
    ]
  },
  {
    name: "artifact_derivations_exist",
    sql: `
      SELECT concat(derivation_type, ' ', content_text) AS value
      FROM artifact_derivations
      ORDER BY created_at ASC
    `,
    expectIncludes: [
      "ocr Whiteboard photo from the March redesign packet",
      "ocr March redesign packet says the Steve graph should expand",
      "transcription Voice memo says the graph should expand from Steve to Chiang Mai to Thailand"
    ]
  },
  {
    name: "derivation_jobs_completed",
    sql: `
      SELECT concat(job_kind, ' ', status) AS value
      FROM derivation_jobs
      ORDER BY created_at ASC
    `,
    expectIncludes: ["ocr completed", "transcription completed"]
  },
  {
    name: "derivation_worker_run_logged",
    sql: `
      SELECT concat(worker_key, ' ', status, ' ', coalesce(summary_json->>'provider', 'none')) AS value
      FROM ops.worker_runs
      WHERE worker_key = 'derivation'
      ORDER BY started_at DESC
      LIMIT 1
    `,
    expectIncludes: ["derivation succeeded", "external"]
  },
  {
    name: "routine_entities_exist",
    sql: `
      SELECT concat(state_type, ' ', coalesce(state_value->>'routine', state_key)) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'routine'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: ["routine Tuesday coworking at Yellow co-working space"]
  },
  {
    name: "style_spec_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'style_spec'
      ORDER BY canonical_name
    `,
    expectIncludes: [
      "style_spec Ask NotebookLM First Before Changing Ontology",
      "style_spec Chunk Large PDF Uploads Before Processing",
      "style_spec Keep Responses Concise",
      "style_spec Prefer Natural-Language Queryability",
      "style_spec Wipe And Replay The Database After Each Slice"
    ]
  },
  {
    name: "style_spec_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'style_spec'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: [
      "style_spec:ask_notebooklm_first_before_changing_ontology",
      "style_spec:chunk_large_pdf_uploads_before_processing",
      "style_spec:keep_responses_concise",
      "style_spec:prefer_natural-language_queryability",
      "style_spec:wipe_and_replay_database_after_each_slice"
    ]
  },
  {
    name: "heuristic_clarification_constraint_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text, ' ', metadata::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'constraint'
        AND state_key = 'constraint:ask_for_clarification_instead_of_guessing'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    expectIncludes: [
      "constraint:ask_for_clarification_instead_of_guessing",
      "heuristic_induction",
      "rule_of_3_distinct_days",
      "\"induced\": true"
    ]
  },
  {
    name: "heuristic_replay_integrity_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text, ' ', metadata::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'style_spec'
        AND state_key = 'style_spec:wipe_and_replay_database_after_each_slice'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    expectIncludes: [
      "style_spec:wipe_and_replay_database_after_each_slice",
      "induced",
      "heuristic_induction",
      "rule_of_3_distinct_days"
    ]
  },
  {
    name: "goal_entity_exists",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'goal'
      ORDER BY canonical_name
    `,
    expectIncludes: ["goal Stay in Thailand"]
  },
  {
    name: "current_goal_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'goal'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: ["current_primary_goal", "Stay in Thailand"]
  },
  {
    name: "mutable_goal_state_summary_active",
    sql: `
      SELECT concat(memory_kind, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND memory_kind = 'state_summary'
        AND canonical_key = 'reconsolidated:state_summary:goal:current_primary_goal'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    expectIncludes: ["state_summary reconsolidated:state_summary:goal:current_primary_goal", "Stay in Thailand"]
  },
  {
    name: "mutable_goal_state_summary_superseded",
    sql: `
      SELECT concat(status, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:state_summary:goal:current_primary_goal'
        AND status = 'superseded'
      ORDER BY valid_from DESC
    `,
    expectIncludes: ["superseded reconsolidated:state_summary:goal:current_primary_goal", "test stale goal text"]
  },
  {
    name: "archived_non_anchor_semantic_summary_exists",
    sql: `
      SELECT concat(status, ' ', canonical_key, ' ', coalesce(metadata->>'archival_tier', ''), ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:profile_summary:legacy_archive:apogee'
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    expectIncludes: ["archived reconsolidated:profile_summary:legacy_archive:apogee cold Legacy project archive summary for Apogee work history"]
  },
  {
    name: "anchor_state_summary_not_archived",
    sql: `
      SELECT concat(status, ' ', canonical_key, ' ', coalesce(metadata->>'source', '')) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:state_summary:goal:current_primary_goal'
      ORDER BY valid_from DESC
      LIMIT 1
    `,
    expectIncludes: ["active reconsolidated:state_summary:goal:current_primary_goal"]
  },
  {
    name: "semantic_archival_event_logged",
    sql: `
      SELECT concat(action, ' ', coalesce(sde.metadata->>'archival_tier', ''), ' ', canonical_key) AS value
      FROM semantic_decay_events sde
      JOIN semantic_memory sm ON sm.id = sde.semantic_memory_id
      WHERE sde.namespace_id = 'personal'
        AND sm.canonical_key = 'reconsolidated:profile_summary:legacy_archive:apogee'
      ORDER BY sde.created_at DESC
      LIMIT 1
    `,
    expectIncludes: ["archived cold reconsolidated:profile_summary:legacy_archive:apogee"]
  },
  {
    name: "archived_temporal_day_nodes_exist",
    sql: `
      SELECT concat(status, ' ', archival_tier, ' ', layer, ' ', to_char(period_start, 'YYYY-MM-DD')) AS value
      FROM temporal_nodes
      WHERE namespace_id = 'personal'
        AND layer = 'day'
        AND status = 'archived'
      ORDER BY period_start ASC
      LIMIT 3
    `,
    expectIncludes: ["archived cold day"]
  },
  {
    name: "archived_temporal_members_preserved",
    sql: `
      SELECT concat(tn.status, ' ', tn.archival_tier, ' ', count(tnm.id)::text) AS value
      FROM temporal_nodes tn
      JOIN temporal_node_members tnm ON tnm.temporal_node_id = tn.id
      WHERE tn.namespace_id = 'personal'
        AND tn.layer = 'day'
        AND tn.status = 'archived'
      GROUP BY tn.id, tn.status, tn.archival_tier
      ORDER BY count(tnm.id) DESC, tn.id
      LIMIT 1
    `,
    expectIncludes: ["archived cold"]
  },
  {
    name: "temporal_archival_event_logged",
    sql: `
      SELECT concat(action, ' ', new_tier, ' ', tn.layer) AS value
      FROM temporal_decay_events tde
      JOIN temporal_nodes tn ON tn.id = tde.temporal_node_id
      WHERE tde.namespace_id = 'personal'
      ORDER BY tde.created_at DESC
      LIMIT 5
    `,
    expectIncludes: ["archived cold day"]
  },
  {
    name: "plan_entity_exists",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'plan'
      ORDER BY canonical_name
    `,
    expectIncludes: ["plan Attend conference in Turkey for Two-Way"]
  },
  {
    name: "plan_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'plan'
        AND valid_until IS NULL
      ORDER BY state_key
    `,
    expectIncludes: ["plan:attend_conference_in_turkey_for_two-way", "Turkey", "Two-Way"]
  },
  {
    name: "belief_entities_exist",
    sql: `
      SELECT concat(entity_type, ' ', canonical_name) AS value
      FROM entities
      WHERE namespace_id = 'personal'
        AND entity_type = 'belief'
      ORDER BY canonical_name
    `,
    expectIncludes: [
      "belief Hosted infrastructure is the pragmatic choice for Brain 2.0 while the local stack is not ready yet",
      "belief Local-first architecture with local Qwen embeddings is the right direction for Brain 2.0",
      "belief Python is fine for most work, including workers, when delivery speed matters more than raw concurrency",
      "belief Rust is the better choice for high-concurrency workers because Python's GIL is too restrictive"
    ]
  },
  {
    name: "belief_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'belief'
      ORDER BY valid_from
    `,
    expectIncludes: [
      "belief:infrastructure",
      "Hosted infrastructure",
      "Local-first architecture with local Qwen embeddings",
      "belief:python_high-concurrency_jobs",
      "Rust is the better choice for high-concurrency workers"
    ]
  },
  {
    name: "clarification_uncle_exists",
    sql: `
      SELECT concat(ambiguity_type, ' ', coalesce(subject_text, ''), ' ', coalesce(object_text, ''), ' ', coalesce(metadata->>'raw_ambiguous_text', '')) AS value
      FROM claim_candidates
      WHERE namespace_id = 'personal'
        AND ambiguity_state = 'requires_clarification'
      ORDER BY created_at DESC
    `,
    expectIncludes: ["kinship_resolution", "Uncle"]
  },
  {
    name: "salience_metadata_exists",
    sql: `
      SELECT concat(content, ' ', metadata::text) AS value
      FROM episodic_memory
      WHERE namespace_id = 'personal'
        AND (metadata ? 'salience_labels' OR metadata ? 'surprise_magnitude')
      ORDER BY occurred_at DESC
    `,
    expectIncludes: ["surprise_magnitude", "salience_labels", "frustrated", "excited"]
  },
  {
    name: "reconsolidated_day_summary_exists",
    sql: `
      SELECT concat(memory_kind, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:day_summary:2026-03-20'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
    `,
    expectIncludes: ["day_summary reconsolidated:day_summary:2026-03-20", "March 20, 2026", "Coworking", "Massage", "Dinner"]
  },
  {
    name: "reconsolidation_event_logged",
    sql: `
      SELECT concat(action, ' ', target_memory_kind, ' ', trigger_confidence) AS value
      FROM memory_reconsolidation_events
      WHERE namespace_id = 'personal'
        AND query_text = 'what did Steve do on March 20 2026?'
      ORDER BY created_at DESC
    `,
    expectIncludes: ["day_summary weak"]
  },
  {
    name: "nina_relationship_profile_summary_active",
    sql: `
      SELECT concat(memory_kind, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:profile_summary:relationship:nina'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
    `,
    expectIncludes: ["profile_summary reconsolidated:profile_summary:relationship:nina", "Nina's current relationship status is unknown", "Omar"]
  },
  {
    name: "nina_relationship_profile_summary_superseded",
    sql: `
      SELECT concat(status, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:profile_summary:relationship:nina'
        AND status = 'superseded'
      ORDER BY valid_from DESC
    `,
    expectIncludes: ["superseded reconsolidated:profile_summary:relationship:nina", "Nina is currently dating Omar."]
  },
  {
    name: "relationship_profile_reconsolidation_event_logged",
    sql: `
      SELECT concat(action, ' ', target_memory_kind, ' ', reason) AS value
      FROM memory_reconsolidation_events
      WHERE namespace_id = 'personal'
        AND query_text = 'check Nina''s profile summary for consistency.'
      ORDER BY created_at DESC
    `,
    expectIncludes: ["profile_summary", "Superseded a stale relationship profile summary"]
  },
  {
    name: "belief_profile_summary_active",
    sql: `
      SELECT concat(memory_kind, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:belief_summary:python_high_concurrency_jobs'
        AND status = 'active'
        AND valid_until IS NULL
      ORDER BY valid_from DESC
    `,
    expectIncludes: [
      "belief_summary reconsolidated:belief_summary:python_high_concurrency_jobs",
      "current stance on python high concurrency jobs",
      "Rust is the better choice"
    ]
  },
  {
    name: "belief_profile_summary_superseded",
    sql: `
      SELECT concat(status, ' ', canonical_key, ' ', content_abstract) AS value
      FROM semantic_memory
      WHERE namespace_id = 'personal'
        AND canonical_key = 'reconsolidated:belief_summary:python_high_concurrency_jobs'
        AND status = 'superseded'
      ORDER BY valid_from DESC
    `,
    expectIncludes: ["superseded reconsolidated:belief_summary:python_high_concurrency_jobs", "Python is still the right choice for all workers"]
  },
  {
    name: "belief_profile_reconsolidation_event_logged",
    sql: `
      SELECT concat(action, ' ', target_memory_kind, ' ', reason) AS value
      FROM memory_reconsolidation_events
      WHERE namespace_id = 'personal'
        AND query_text = 'check belief summary for Python high-concurrency jobs for consistency.'
      ORDER BY created_at DESC
    `,
    expectIncludes: ["belief_summary", "Superseded a stale belief summary"]
  },
  {
    name: "heuristic_large_pdf_state_exists",
    sql: `
      SELECT concat(state_key, ' ', state_value::text, ' ', metadata::text) AS value
      FROM procedural_memory
      WHERE namespace_id = 'personal'
        AND state_type = 'style_spec'
        AND state_key = 'style_spec:chunk_large_pdf_uploads_before_processing'
        AND valid_until IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    expectIncludes: [
      "style_spec:chunk_large_pdf_uploads_before_processing",
      "induced",
      "large_pdf_protocol",
      "rule_of_3_distinct_days"
    ]
  },
  {
    name: "episodic_blocking_fk_count_zero",
    sql: `
      SELECT count(*)::text AS value
      FROM pg_constraint
      WHERE confrelid = 'episodic_memory'::regclass
        AND contype = 'f'
    `,
    expectIncludes: ["0"]
  },
  {
    name: "episodic_loose_provenance_orphans_zero",
    sql: `
      SELECT count(*)::text AS value
      FROM episodic_loose_provenance_audit
      WHERE orphan_count > 0
    `,
    expectIncludes: ["0"]
  },
];

export async function resetDatabase(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await client.query<{ table_name: string }>(
      `
        SELECT tablename AS table_name
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> 'schema_migrations'
        ORDER BY tablename
      `
    );

    const tables = rows.rows
      .map((row) => row.table_name)
      .sort((left, right) => {
        const priority = (name: string): number => {
          if (name === "episodic_timeline_legacy") {
            return 0;
          }
          if (name === "episodic_memory") {
            return 2;
          }
          return 1;
        };
        return priority(left) - priority(right) || left.localeCompare(right);
      });

    if (tables.length === 0) {
      return;
    }

    for (const tableName of tables) {
      await client.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`);
    }
  });
}

export async function seedNamespace(namespaceId: string): Promise<number> {
  const generatedFixtures = await ensureGeneratedFixtures();
  const missingFixtures: string[] = [];
  for (const fixture of FIXTURES) {
    try {
      await access(fixture.path);
    } catch {
      missingFixtures.push(fixture.path);
    }
  }

  if (missingFixtures.length > 0) {
    throw new Error(
      [
        `Life replay fixtures are missing.`,
        `Set BRAIN_LIFE_REPLAY_FIXTURE_ROOT to a private corpus directory containing the expected replay files.`,
        `Fixture root: ${replayFixtureRoot()}`,
        `Missing files:`,
        ...missingFixtures.map((entry) => `- ${entry}`)
      ].join("\n")
    );
  }

  const allFixtures: readonly ReplayFixture[] = [...FIXTURES, ...generatedFixtures];

  for (const fixture of allFixtures) {
    const ingestResult = await ingestArtifact({
      inputUri: fixture.path,
      namespaceId,
      sourceType: fixture.sourceType,
      sourceChannel: fixture.sourceChannel,
      capturedAt: fixture.capturedAt
    });

    const generatedFixture = generatedFixtures.find((entry) => entry.path === fixture.path);
    if (generatedFixture?.derivation) {
      await enqueueDerivationJob({
        namespaceId,
        artifactId: ingestResult.artifact.artifactId,
        artifactObservationId: ingestResult.artifact.observationId,
        jobKind: generatedFixture.derivation.jobKind,
        modality: generatedFixture.derivation.modality,
        metadata: {
          manual_content_text: generatedFixture.derivation.manualContentText,
          ...(generatedFixture.derivation.metadata ?? {})
        }
      });
    }
  }

  await executeDerivationWorker({
    namespaceId,
    limit: 16,
    triggerType: "repair",
    workerId: "life-replay:derivation-worker"
  });

  await runRelationshipAdjudication(namespaceId, {
    limit: 1200,
    acceptThreshold: 0.58,
    rejectThreshold: 0.38
  });
  await runCandidateConsolidation(namespaceId, 1200);

  for (const layer of ["day", "week", "month", "year"] as const) {
    await runTemporalSummaryScaffold(namespaceId, {
      layer,
      lookbackDays: 5000,
      maxMembersPerNode: 256
    });
  }

  await withTransaction(async (client) => {
    const sourceResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND content ILIKE '%Nina is currently dating Omar%'
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId]
    );

    await client.query(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.82, $3::timestamptz, NULL, 'active', true, $4::uuid, 'profile_summary', $5, $6::jsonb, $7::jsonb, true)
      `,
      [
        namespaceId,
        "Nina is currently dating Omar.",
        "2026-01-15T09:00:00Z",
        sourceResult.rows[0]?.id ?? null,
        "reconsolidated:profile_summary:relationship:nina",
        JSON.stringify({
          person_name: "Nina",
          partner_name: "Omar"
        }),
        JSON.stringify({
          source: "life_replay_stale_profile_seed",
          seeded_for_reconsolidation: true
        })
      ]
    );

    const staleBeliefSource = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND content ILIKE '%Python is fine for most work%'
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId]
    );

    await client.query(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.82, $3::timestamptz, NULL, 'active', true, $4::uuid, 'belief_summary', $5, $6::jsonb, $7::jsonb, true)
      `,
      [
        namespaceId,
        "Steve's current stance on python high concurrency jobs is Python is still the right choice for all workers.",
        "2025-03-20T09:00:00Z",
        staleBeliefSource.rows[0]?.id ?? null,
        "reconsolidated:belief_summary:python_high_concurrency_jobs",
        JSON.stringify({
          topic: "Python high-concurrency jobs",
          belief_text: "Python is still the right choice for all workers."
        }),
        JSON.stringify({
          source: "life_replay_stale_belief_seed",
          seeded_for_reconsolidation: true
        })
      ]
    );

    const staleGoalSource = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND content ILIKE '%goal: stay in thailand%'
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId]
    );

    await client.query(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.82, $3::timestamptz, NULL, 'active', true, $4::uuid, 'state_summary', $5, $6::jsonb, $7::jsonb, true)
      `,
      [
        namespaceId,
        "Steve's current primary goal is test stale goal text.",
        "2025-01-01T09:00:00Z",
        staleGoalSource.rows[0]?.id ?? null,
        "reconsolidated:state_summary:goal:current_primary_goal",
        JSON.stringify({
          state_type: "goal",
          state_key: "current_primary_goal",
          state_value: { goal: "test stale goal text" }
        }),
        JSON.stringify({
          source: "life_replay_stale_state_seed",
          seeded_for_reconsolidation: true
        })
      ]
    );

    const archivalSource = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND content ILIKE '%Apogee Software%'
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId]
    );

    await client.query(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt,
          last_accessed_at,
          access_count
        )
        VALUES ($1, $2, 0.12, $3::timestamptz, NULL, 'active', false, $4::uuid, 'profile_summary', $5, $6::jsonb, $7::jsonb, false, $8::timestamptz, 0)
      `,
      [
        namespaceId,
        "Legacy project archive summary for Apogee work history.",
        "2025-01-10T09:00:00Z",
        archivalSource.rows[0]?.id ?? null,
        "reconsolidated:profile_summary:legacy_archive:apogee",
        JSON.stringify({
          topic: "Apogee Software",
          summary: "Legacy project archive summary for Apogee work history."
        }),
        JSON.stringify({
          source: "life_replay_archival_seed",
          seeded_for_archival: true
        }),
        "2025-01-15T09:00:00Z"
      ]
    );
  });

  await runUniversalMutableReconsolidation(namespaceId);
  await runSemanticDecay(namespaceId, {
    limit: 800,
    inactivityHours: 24 * 30,
    coldInactivityHours: 24 * 90,
    decayFactor: 0.5,
    minimumScore: 0.1
  });
  await runTemporalNodeArchival(namespaceId, {
    limit: 1600
  });

  return allFixtures.length;
}

function aggregateContent(values: readonly RecallResult[]): string {
  return values.map((value) => value.content).join("\n").toLowerCase();
}

function confidenceRank(value: RecallConfidenceGrade): number {
  switch (value) {
    case "confident":
      return 2;
    case "weak":
      return 1;
    case "missing":
    default:
      return 0;
  }
}

async function runQueryExpectation(namespaceId: string, expectation: ReplayQueryExpectation): Promise<ReplayQueryResult> {
  const result = await searchMemory({
    namespaceId,
    query: expectation.query,
    limit: 8
  });

  const failures: string[] = [];
  const topTypes = result.results.slice(0, 3).map((item) => item.memoryType);
  const joined = aggregateContent(result.results);
  const assessment = result.meta.answerAssessment;
  const expectedAbstention = Boolean(expectation.expectNoResults && result.results.length === 0);
  const confidence = expectedAbstention ? "weak" : (assessment?.confidence ?? "missing");
  const confidenceReason = expectedAbstention
    ? "Expected abstention: no active result was returned for a query that should currently have no answer."
    : (assessment?.reason ?? "missing answer assessment");
  const dualityPresent = Boolean(
    result.meta.contractVersion === "duality_v2" &&
    result.duality?.claim &&
    typeof result.duality.claim.text === "string" &&
    Array.isArray(result.duality.evidence)
  );
  const directEvidence = assessment?.directEvidence ?? false;
  const evidenceCount = result.evidence.length;

  if (expectation.expectTopTypes && !topTypes.some((type) => expectation.expectTopTypes?.includes(type))) {
    failures.push(`expected top types ${expectation.expectTopTypes.join(", ")}, got ${topTypes.join(", ") || "none"}`);
  }

  for (const term of expectation.expectTopIncludes) {
    if (!joined.includes(term.toLowerCase())) {
      failures.push(`missing term ${term}`);
    }
  }

  if (expectation.requireEvidence && result.evidence.length === 0) {
    failures.push("missing evidence bundle");
  }

  if (expectation.requireEvidence && result.evidence.some((item) => !item.sourceUri && !item.artifactId)) {
    failures.push("evidence item missing source reference");
  }

  if (!dualityPresent) {
    failures.push("missing claim-plus-evidence contract");
  }

  if ((expectation.requireEvidence || expectation.requireDuality) && !dualityPresent) {
    failures.push("missing claim-plus-evidence duality object");
  }

  for (const term of expectation.expectedDualityClaimIncludes ?? []) {
    if (!String(result.duality?.claim.text ?? "").toLowerCase().includes(term.toLowerCase())) {
      failures.push(`missing duality claim term ${term}`);
    }
  }

  if (expectation.expectedFollowUpAction && result.meta.followUpAction !== expectation.expectedFollowUpAction) {
    failures.push(`expected follow-up action ${expectation.expectedFollowUpAction}, got ${result.meta.followUpAction ?? "none"}`);
  }

  if (expectation.expectedPlannerQueryClass && result.meta.planner.queryClass !== expectation.expectedPlannerQueryClass) {
    failures.push(`expected planner query class ${expectation.expectedPlannerQueryClass}, got ${result.meta.planner.queryClass}`);
  }

  if (
    expectation.expectedLeafEvidenceRequired !== undefined &&
    result.meta.planner.leafEvidenceRequired !== expectation.expectedLeafEvidenceRequired
  ) {
    failures.push(
      `expected leafEvidenceRequired=${String(expectation.expectedLeafEvidenceRequired)}, got ${String(result.meta.planner.leafEvidenceRequired)}`
    );
  }

  if (
    expectation.expectedTemporalGateTriggered !== undefined &&
    Boolean(result.meta.temporalGateTriggered) !== expectation.expectedTemporalGateTriggered
  ) {
    failures.push(
      `expected temporalGateTriggered=${String(expectation.expectedTemporalGateTriggered)}, got ${String(Boolean(result.meta.temporalGateTriggered))}`
    );
  }

  if (
    expectation.expectedTemporalSummarySufficient !== undefined &&
    Boolean(result.meta.temporalSummarySufficient) !== expectation.expectedTemporalSummarySufficient
  ) {
    failures.push(
      `expected temporalSummarySufficient=${String(expectation.expectedTemporalSummarySufficient)}, got ${String(Boolean(result.meta.temporalSummarySufficient))}`
    );
  }

  if (expectation.expectedClarificationToolName) {
    const toolName = result.duality.clarificationHint?.mcpTool?.name ?? result.meta.clarificationHint?.mcpTool?.name;
    if (toolName !== expectation.expectedClarificationToolName) {
      failures.push(`expected clarification tool ${expectation.expectedClarificationToolName}, got ${toolName ?? "none"}`);
    }
  }

  if (expectation.minimumConfidence && confidenceRank(confidence) < confidenceRank(expectation.minimumConfidence)) {
    failures.push(`confidence ${confidence} below required ${expectation.minimumConfidence}`);
  }

  for (const term of expectation.expectExcludes ?? []) {
    if (joined.includes(term.toLowerCase())) {
      failures.push(`unexpected term ${term}`);
    }
  }

  return {
    name: expectation.name,
    query: expectation.query,
    passed: failures.length === 0,
    failures,
    confidence,
    confidenceReason,
    dualityPresent,
    evidenceCount,
    directEvidence
  };
}

async function runStateExpectation(expectation: ReplayStateExpectation): Promise<ReplayStateResult> {
  const rows = await queryRows<{ value: string }>(expectation.sql);
  const joined = rows.map((row) => row.value).join("\n");
  const failures = expectation.expectIncludes
    .filter((term) => !joined.includes(term))
    .map((term) => `missing term ${term}`);

  for (const term of expectation.expectExcludes ?? []) {
    if (joined.includes(term)) {
      failures.push(`unexpected term ${term}`);
    }
  }

  return {
    name: expectation.name,
    passed: failures.length === 0,
    failures
  };
}

async function runGraphExpectation(namespaceId: string, expectation: ReplayGraphExpectation): Promise<ReplayGraphResult> {
  const graph = await getOpsRelationshipGraph(namespaceId, {
    entityName: expectation.entityName,
    timeStart: expectation.timeStart,
    timeEnd: expectation.timeEnd,
    limit: 80
  });

  const nodeNames = graph.nodes.map((node) => node.name).join("\n");
  const edgePredicates = graph.edges.map((edge) => edge.predicate);
  const failures = expectation.expectNodeIncludes
    .filter((term) => !nodeNames.includes(term))
    .map((term) => `missing node ${term}`);

  for (const predicate of expectation.expectEdgePredicates ?? []) {
    if (!edgePredicates.includes(predicate)) {
      failures.push(`missing edge predicate ${predicate}`);
    }
  }

  return {
    name: expectation.name,
    passed: failures.length === 0,
    failures
  };
}

async function runOpsExpectation(
  namespaceId: string,
  expectation: (typeof OPS_EXPECTATIONS)[number]
): Promise<ReplayOpsResult> {
  const timeline = await getOpsTimelineView(namespaceId, expectation.timeStart, expectation.timeEnd, 80);
  const failures: string[] = [];

  if (timeline.containmentAudit.violationCount !== 0) {
    failures.push(`expected 0 containment violations, got ${timeline.containmentAudit.violationCount}`);
  }
  if (!timeline.causalOverlays.some((overlay) => overlay.kind === "semantic_supersession")) {
    failures.push("missing semantic_supersession overlay");
  }
  if (!timeline.causalOverlays.some((overlay) => overlay.kind === "procedural_supersession")) {
    failures.push("missing procedural_supersession overlay");
  }

  return {
    name: expectation.name,
    passed: failures.length === 0,
    failures
  };
}

function toMarkdown(report: LifeReplayBenchmarkReport): string {
  const lines: string[] = [
    "# Life Replay Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Namespace: ${report.namespaceId}`,
    `Reset database: ${report.resetDatabase}`,
    `Seeded artifacts: ${report.seededArtifacts}`,
    `Confident queries: ${report.confidentCount}`,
    `Weak queries: ${report.weakCount}`,
    `Missing queries: ${report.missingCount}`,
    `Passed: ${report.passed}`,
    ""
  ];

  lines.push("## Query Results", "");
  for (const item of report.queryResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"} | confidence=${item.confidence} | evidence=${item.evidenceCount} | direct=${item.directEvidence ? "yes" : "no"}`);
    lines.push(`  query: ${item.query}`);
    lines.push(`  reason: ${item.confidenceReason}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## State Results", "");
  for (const item of report.stateResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Graph Results", "");
  for (const item of report.graphResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("", "## Ops Results", "");
  for (const item of report.opsResults) {
    lines.push(`- ${item.name}: ${item.passed ? "pass" : "fail"}`);
    if (item.failures.length > 0) {
      lines.push(`  failures: ${item.failures.join("; ")}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runLifeReplayBenchmark(): Promise<LifeReplayBenchmarkReport> {
  return withMaintenanceLock("the life replay benchmark", async () => {
    const namespaceId = "personal";
    await runMigrations();
    await resetDatabase();
    const seededArtifacts = await seedNamespace(namespaceId);

    const queryResults: ReplayQueryResult[] = [];
    for (const expectation of QUERY_EXPECTATIONS) {
      if (expectation.name === "day_summary_query_reconsolidated") {
        await runMemoryReconsolidation({
          namespaceId,
          query: "what did Steve do on March 20 2026?",
          limit: 8
        });
      }
      if (expectation.beforeReconsolidationQuery) {
        await runMemoryReconsolidation({
          namespaceId,
          query: expectation.beforeReconsolidationQuery,
          limit: 8
        });
      }
      queryResults.push(await runQueryExpectation(namespaceId, expectation));
    }

    const stateResults: ReplayStateResult[] = [];
    for (const expectation of STATE_EXPECTATIONS) {
      stateResults.push(await runStateExpectation(expectation));
    }

    const graphResults: ReplayGraphResult[] = [];
    for (const expectation of GRAPH_EXPECTATIONS) {
      graphResults.push(await runGraphExpectation(namespaceId, expectation));
    }

    const opsResults: ReplayOpsResult[] = [];
    for (const expectation of OPS_EXPECTATIONS) {
      opsResults.push(await runOpsExpectation(namespaceId, expectation));
    }

    const confidentCount = queryResults.filter((item) => item.confidence === "confident").length;
    const weakCount = queryResults.filter((item) => item.confidence === "weak").length;
    const missingCount = queryResults.filter((item) => item.confidence === "missing").length;

    return {
      generatedAt: new Date().toISOString(),
      namespaceId,
      resetDatabase: true,
      seededArtifacts,
      queryResults,
      stateResults,
      graphResults,
      opsResults,
      confidentCount,
      weakCount,
      missingCount,
      passed: [...queryResults, ...stateResults, ...graphResults, ...opsResults].every((item) => item.passed)
    };
  });
}

export async function runAndWriteLifeReplayBenchmark(): Promise<{
  readonly report: LifeReplayBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  try {
    const report = await runLifeReplayBenchmark();
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const jsonPath = path.join(dir, `life-replay-${stamp}.json`);
    const markdownPath = path.join(dir, `life-replay-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(markdownPath, toMarkdown(report), "utf8");
    await writeFile(path.join(dir, "life-replay-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(dir, "life-replay-latest.md"), toMarkdown(report), "utf8");
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
