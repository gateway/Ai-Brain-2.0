import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, queryRows, withTransaction } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { ingestArtifact } from "../ingest/worker.js";
import { runCandidateConsolidation } from "../jobs/consolidation.js";
import { runRelationshipAdjudication } from "../jobs/relationship-adjudication.js";
import { getOpsRelationshipGraph } from "../ops/service.js";
import { runTemporalSummaryScaffold } from "../jobs/temporal-summary.js";
import { runMemoryReconsolidation } from "../jobs/memory-reconsolidation.js";
import { searchMemory } from "../retrieval/service.js";
import type { RecallConfidenceGrade } from "../retrieval/types.js";
import type { RecallResult, SourceType } from "../types.js";

interface ReplayFixture {
  readonly path: string;
  readonly sourceType: SourceType;
  readonly sourceChannel: string;
  readonly capturedAt: string;
}

interface ReplayQueryExpectation {
  readonly name: string;
  readonly query: string;
  readonly expectTopTypes?: readonly RecallResult["memoryType"][];
  readonly expectTopIncludes: readonly string[];
  readonly expectExcludes?: readonly string[];
  readonly requireEvidence?: boolean;
  readonly requireDuality?: boolean;
  readonly minimumConfidence?: RecallConfidenceGrade;
  readonly expectNoResults?: boolean;
  readonly expectedFollowUpAction?: "none" | "suggest_verification" | "route_to_clarifications";
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

export interface LifeReplayBenchmarkReport {
  readonly generatedAt: string;
  readonly namespaceId: string;
  readonly resetDatabase: boolean;
  readonly seededArtifacts: number;
  readonly queryResults: readonly ReplayQueryResult[];
  readonly stateResults: readonly ReplayStateResult[];
  readonly graphResults: readonly ReplayGraphResult[];
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
    minimumConfidence: "confident"
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
    expectExcludes: ["Lauren"],
    expectNoResults: true,
    requireDuality: true,
    expectedFollowUpAction: "route_to_clarifications"
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
    requireEvidence: true
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
    requireEvidence: true
  },
  {
    name: "day_summary_query_reconsolidated",
    query: "what did Steve do on March 20 2026?",
    expectTopTypes: ["semantic_memory"],
    expectTopIncludes: ["March 20, 2026", "Coworking", "Massage", "Dinner"],
    requireEvidence: true,
    minimumConfidence: "confident"
  },
  {
    name: "temporal_detail_cost_query",
    query: "how much did coworking cost on March 20 2026?",
    expectTopTypes: ["episodic_memory", "narrative_event"],
    expectTopIncludes: ["250 baht", "Yellow"],
    requireEvidence: true,
    minimumConfidence: "confident"
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
  }
];

const GRAPH_EXPECTATIONS: readonly ReplayGraphExpectation[] = [
  {
    name: "steve_focus_graph",
    entityName: "Steve Tietze",
    expectNodeIncludes: ["Yellow co-working space", "Dinner with Dan at Chiang Mai", "Dan", "Two-Way"],
    expectEdgePredicates: ["participated_in", "includes"]
  }
];

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
      SELECT concat(predicate, ' ', valid_from::text, ' ', coalesce(valid_until::text, 'active')) AS value
      FROM relationship_memory rm
      JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity ON object_entity.id = rm.object_entity_id
      WHERE rm.namespace_id = 'personal'
        AND rm.predicate = 'significant_other_of'
        AND subject_entity.canonical_name = 'Steve Tietze'
        AND object_entity.canonical_name = 'Lauren'
    `,
    expectIncludes: ["significant_other_of"]
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
    expectIncludes: ["constraint Ask For Clarification Instead Of Guessing", "constraint Never Silently Rewrite Raw Source Truth", "constraint Return Ground-Truth Source Document With Search Results"]
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
      "style_spec:keep_responses_concise",
      "style_spec:prefer_natural-language_queryability",
      "style_spec:wipe_and_replay_database_after_each_slice"
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
  }
];

async function resetDatabase(): Promise<void> {
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

    const tables = rows.rows.map((row) => `"${row.table_name}"`);
    if (tables.length === 0) {
      return;
    }

    await client.query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  });
}

async function seedNamespace(namespaceId: string): Promise<number> {
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

  for (const fixture of FIXTURES) {
    await ingestArtifact({
      inputUri: fixture.path,
      namespaceId,
      sourceType: fixture.sourceType,
      sourceChannel: fixture.sourceChannel,
      capturedAt: fixture.capturedAt
    });
  }

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

  return FIXTURES.length;
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

  if (expectation.expectedFollowUpAction && result.meta.followUpAction !== expectation.expectedFollowUpAction) {
    failures.push(`expected follow-up action ${expectation.expectedFollowUpAction}, got ${result.meta.followUpAction ?? "none"}`);
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

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runLifeReplayBenchmark(): Promise<LifeReplayBenchmarkReport> {
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
    confidentCount,
    weakCount,
    missingCount,
    passed: [...queryResults, ...stateResults, ...graphResults].every((item) => item.passed)
  };
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
