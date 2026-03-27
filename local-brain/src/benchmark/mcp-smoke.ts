import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../db/client.js";
import { executeMcpTool } from "../mcp/server.js";
import { runAndWriteHumanSyntheticWatchBenchmark } from "./human-synthetic-watch.js";
import { runAndWriteLifeReplayBenchmark } from "./life-replay.js";
import { runAndWriteOmiWatchSmokeBenchmark } from "./omi-watch-smoke.js";

type McpPromptClass = "who" | "what" | "where" | "when" | "why";
type McpToolName =
  | "memory.search"
  | "memory.timeline"
  | "memory.get_relationships"
  | "memory.get_graph"
  | "memory.get_clarifications"
  | "memory.get_artifact"
  | "memory.get_stats"
  | "memory.get_protocols";
type RecallConfidence = "confident" | "weak" | "missing";
type FollowUpAction = "none" | "suggest_verification" | "route_to_clarifications";

interface McpScenario {
  readonly name: string;
  readonly namespaceId: string;
  readonly promptClass: McpPromptClass;
  readonly tool: McpToolName;
  readonly args: Record<string, unknown>;
  readonly expectedTerms?: readonly string[];
  readonly expectedConfidence?: RecallConfidence;
  readonly expectedFollowUpAction?: FollowUpAction;
  readonly requireEvidence?: boolean;
  readonly requireSourceLink?: boolean;
  readonly requireProvenanceAnswer?: boolean;
  readonly followUpTool?: {
    readonly name:
      | "memory.get_clarifications"
      | "memory.get_relationships"
      | "memory.get_graph"
      | "memory.timeline"
      | "memory.get_artifact"
      | "memory.get_stats"
      | "memory.get_protocols";
    readonly args: Record<string, unknown>;
    readonly expectedTerms?: readonly string[];
    readonly minimumItemCount?: number;
  };
  readonly validate?: (structuredContent: any) => readonly string[];
}

interface McpScenarioResult {
  readonly name: string;
  readonly namespaceId: string;
  readonly promptClass: McpPromptClass;
  readonly tool: McpToolName;
  readonly latencyMs: number;
  readonly confidence?: RecallConfidence;
  readonly followUpAction?: string | null;
  readonly evidenceCount: number;
  readonly sourceLinkCount: number;
  readonly followUpToolUsed?: string | null;
  readonly followUpPassed?: boolean;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface McpSmokeBenchmarkReport {
  readonly generatedAt: string;
  readonly replayReportPath: string;
  readonly syntheticWatchReportPath: string;
  readonly omiWatchReportPath: string;
  readonly results: readonly McpScenarioResult[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly byPromptClass: Readonly<Record<McpPromptClass, { readonly passed: number; readonly failed: number }>>;
  };
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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function hasTerm(value: unknown, term: string): boolean {
  return jsonString(value).toLowerCase().includes(term.toLowerCase());
}

function failIf(condition: boolean, message: string, failures: string[]): void {
  if (condition) {
    failures.push(message);
  }
}

function evidenceItems(payload: any): readonly any[] {
  if (Array.isArray(payload?.duality?.evidence)) {
    return payload.duality.evidence;
  }
  if (Array.isArray(payload?.evidence)) {
    return payload.evidence;
  }
  return [];
}

function sourceLinkCount(items: readonly any[]): number {
  let count = 0;
  for (const item of items) {
    if (typeof item?.artifactId === "string" && item.artifactId) {
      count += 1;
      continue;
    }
    if (typeof item?.sourceUri === "string" && item.sourceUri) {
      count += 1;
    }
  }
  return count;
}

function clarificationItemCount(payload: any): number {
  return Array.isArray(payload?.items) ? payload.items.length : 0;
}

function listCountForTool(tool: string, payload: any): number {
  switch (tool) {
    case "memory.get_relationships":
      return Array.isArray(payload?.relationships) ? payload.relationships.length : 0;
    case "memory.timeline":
      return Array.isArray(payload?.timeline) ? payload.timeline.length : 0;
    case "memory.get_clarifications":
      return clarificationItemCount(payload);
    case "memory.get_artifact":
      return payload?.artifactId ? 1 : 0;
    case "memory.get_graph":
      return Array.isArray(payload?.edges) ? payload.edges.length : 0;
    case "memory.get_stats":
      return payload?.overview ? 1 : 0;
    case "memory.get_protocols":
      return Array.isArray(payload?.items) ? payload.items.length : 0;
    default:
      return 0;
  }
}

function scenarios(personalNamespaceId: string, syntheticNamespaceId: string, omiNamespaceId: string): readonly McpScenario[] {
  return [
    {
      name: "assistant_where_current_home",
      namespaceId: personalNamespaceId,
      promptClass: "where",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "where does Steve live?",
        limit: 6
      },
      expectedTerms: ["Chiang Mai"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_transcript_karaoke",
      namespaceId: personalNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "what did Dan say about karaoke?",
        limit: 6
      },
      expectedTerms: ["karaoke"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_why_current_home",
      namespaceId: personalNamespaceId,
      promptClass: "why",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "why does the brain believe Steve lives in Chiang Mai?",
        limit: 6
      },
      expectedTerms: ["Chiang Mai"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true,
      requireProvenanceAnswer: true
    },
    {
      name: "assistant_when_march_20",
      namespaceId: personalNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "what did Steve do on March 20 2026?",
        limit: 8
      },
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_who_dating_now_unknown",
      namespaceId: personalNamespaceId,
      promptClass: "who",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "who is Steve dating now?",
        limit: 6
      },
      expectedTerms: ["Unknown"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true
    },
    {
      name: "assistant_who_uncle_unknown",
      namespaceId: personalNamespaceId,
      promptClass: "who",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "who is Uncle?",
        limit: 6
      },
      expectedConfidence: "missing",
      expectedFollowUpAction: "route_to_clarifications",
      followUpTool: {
        name: "memory.get_clarifications",
        args: {
          namespace_id: personalNamespaceId,
          query: "Uncle",
          limit: 10
        },
        expectedTerms: ["clarification"],
        minimumItemCount: 1
      }
    },
    {
      name: "assistant_where_synthetic_historical_home",
      namespaceId: syntheticNamespaceId,
      promptClass: "where",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "where did Steve live before Chiang Mai?",
        limit: 8
      },
      expectedTerms: ["Koh Samui", "Bend"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_when_synthetic_yesterday",
      namespaceId: syntheticNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what did Steve do yesterday?",
        reference_now: "2026-03-21T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["karaoke", "Jules", "Rina"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_when_synthetic_last_weekend",
      namespaceId: syntheticNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what did Steve do last weekend?",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 6
      },
      expectedTerms: ["karaoke"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_when_synthetic_earlier_this_month",
      namespaceId: syntheticNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what happened earlier this month?",
        reference_now: "2026-03-23T12:00:00Z",
        limit: 8
      },
      expectedTerms: ["Pai", "reset"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_personal_omi_recap_ladyboys",
      namespaceId: omiNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: omiNamespaceId,
        query: "Can you give me an overview of that conversation I had with Dan on March 22 2026 about ladyboys?",
        limit: 8
      },
      expectedTerms: ["ladyboys"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true,
      validate: (payload) => {
        const failures: string[] = [];
        const groundedToKnownOmiPath =
          jsonString(payload).includes("/data/inbox/omi/normalized/2026/03/22/") ||
          jsonString(payload).includes("/Library/Application Support/AI-Brain/omi-archive/normalized/2026/03/22/");
        failIf(
          !groundedToKnownOmiPath,
          "Expected recap query to ground to the March 22 OMI normalized artifact.",
          failures
        );
        return failures;
      }
    },
    {
      name: "assistant_what_synthetic_after_karaoke",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "where did Steve and Jules go after karaoke on March 21 2026?",
        limit: 8
      },
      expectedTerms: ["Night Noodle Alley", "Jules"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_synthetic_trip_plan",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what plans does Steve have for the end of April?",
        limit: 8
      },
      expectedTerms: ["Istanbul", "pilots conference"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_synthetic_current_coffee",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what does Steve prefer now for coffee?",
        limit: 8
      },
      expectedTerms: ["pour-over coffee"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_who_synthetic_friends_natural",
      namespaceId: syntheticNamespaceId,
      promptClass: "who",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "who are Steve's friends?",
        limit: 8
      },
      expectedTerms: ["Jules", "Rina", "Omar"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_who_synthetic_work_with_natural",
      namespaceId: syntheticNamespaceId,
      promptClass: "who",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "who does Steve work with?",
        limit: 8
      },
      expectedTerms: ["Theo", "Omar", "Two-Way"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_who_synthetic_karaoke_companions",
      namespaceId: syntheticNamespaceId,
      promptClass: "who",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "who was Steve with at karaoke?",
        limit: 8
      },
      expectedTerms: ["Jules", "Rina"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_personal_movies_like_natural",
      namespaceId: personalNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "what movies does Steve like?",
        limit: 8
      },
      expectedTerms: ["Inception", "Sinners", "Trainspotting"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_synthetic_recent_movies_natural",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what movies has Steve watched recently?",
        limit: 8
      },
      expectedTerms: ["Sinners", "Texas Chainsaw Massacre"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_synthetic_sinners_opinion",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what did Steve think about Sinners versus Texas Chainsaw Massacre?",
        limit: 8
      },
      expectedTerms: ["Sinners"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_where_synthetic_place_history_natural",
      namespaceId: syntheticNamespaceId,
      promptClass: "where",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "where has Steve lived?",
        limit: 8
      },
      expectedTerms: ["Chiang Mai", "Koh Samui", "Bend"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_when_synthetic_lauren_change",
      namespaceId: syntheticNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what happened with Lauren in 2025?",
        limit: 8
      },
      expectedTerms: ["Lauren", "October 18, 2025", "US"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_when_personal_2025_broad_natural",
      namespaceId: personalNamespaceId,
      promptClass: "when",
      tool: "memory.search",
      args: {
        namespace_id: personalNamespaceId,
        query: "what was Steve doing in 2025?",
        limit: 10
      },
      expectedTerms: ["2025"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_why_synthetic_mild_food_provenance",
      namespaceId: syntheticNamespaceId,
      promptClass: "why",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "why does the brain think Steve cannot really do spicy now?",
        limit: 8
      },
      expectedTerms: ["cannot really do spicy", "mild food"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true,
      requireProvenanceAnswer: true
    },
    {
      name: "assistant_why_synthetic_friendship_provenance",
      namespaceId: syntheticNamespaceId,
      promptClass: "why",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "why does the brain think Jules is Steve's friend?",
        limit: 8
      },
      expectedTerms: ["Jules", "friend"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true,
      requireProvenanceAnswer: true
    },
    {
      name: "assistant_why_synthetic_coffee_provenance",
      namespaceId: syntheticNamespaceId,
      promptClass: "why",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "why does the brain think Steve prefers pour-over coffee now?",
        limit: 8
      },
      expectedTerms: ["pour-over coffee"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true,
      requireProvenanceAnswer: true
    },
    {
      name: "assistant_what_synthetic_historical_coffee",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what did Steve use to prefer for coffee?",
        limit: 8
      },
      expectedTerms: ["espresso coffee"],
      expectedConfidence: "confident",
      expectedFollowUpAction: "none",
      requireEvidence: true,
      requireSourceLink: true
    },
    {
      name: "assistant_what_synthetic_secret_rejection",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "what is Steve's SSN?",
        limit: 6
      },
      expectedConfidence: "missing",
      expectedFollowUpAction: "route_to_clarifications"
    },
    {
      name: "assistant_where_synthetic_summer_cabin_unknown",
      namespaceId: syntheticNamespaceId,
      promptClass: "where",
      tool: "memory.search",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "where was the summer cabin?",
        limit: 6
      },
      expectedConfidence: "missing",
      expectedFollowUpAction: "route_to_clarifications",
      followUpTool: {
        name: "memory.get_clarifications",
        args: {
          namespace_id: syntheticNamespaceId,
          query: "summer cabin",
          limit: 10
        },
        minimumItemCount: 1
      }
    },
    {
      name: "assistant_who_synthetic_relationships",
      namespaceId: syntheticNamespaceId,
      promptClass: "who",
      tool: "memory.get_relationships",
      args: {
        namespace_id: syntheticNamespaceId,
        entity_name: "Steve Tietze",
        limit: 24
      },
      expectedTerms: ["Jules", "Rina", "Omar", "Chiang Mai"],
      validate: (payload) => {
        const failures: string[] = [];
        const relationships = Array.isArray(payload?.relationships) ? payload.relationships : [];
        failIf(relationships.length === 0, "Expected non-empty relationship results for Steve Tietze.", failures);
        const predicates = relationships.map((item: any) => asString(item?.predicate));
        failIf(
          !predicates.some((value: string) => ["friend_of", "resides_at", "works_at", "significant_other_of", "was_with"].includes(value)),
          "Expected at least one high-signal relationship predicate.",
          failures
        );
        return failures;
      }
    },
    {
      name: "assistant_who_synthetic_graph_context",
      namespaceId: syntheticNamespaceId,
      promptClass: "who",
      tool: "memory.get_graph",
      args: {
        namespace_id: syntheticNamespaceId,
        entity_name: "Steve Tietze",
        limit: 48
      },
      expectedTerms: ["Jules", "Chiang Mai"],
      validate: (payload) => {
        const failures: string[] = [];
        const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
        const edges = Array.isArray(payload?.edges) ? payload.edges : [];
        failIf(nodes.length < 4, "Expected non-trivial graph node coverage.", failures);
        failIf(edges.length < 3, "Expected non-trivial graph edge coverage.", failures);
        return failures;
      }
    },
    {
      name: "assistant_when_synthetic_timeline_window",
      namespaceId: syntheticNamespaceId,
      promptClass: "when",
      tool: "memory.timeline",
      args: {
        namespace_id: syntheticNamespaceId,
        time_start: "2026-03-21T00:00:00Z",
        time_end: "2026-03-23T23:59:59Z",
        limit: 20
      },
      expectedTerms: ["Saturday", "pilots conference", "summer cabin"],
      validate: (payload) => {
        const failures: string[] = [];
        const timeline = Array.isArray(payload?.timeline) ? payload.timeline : [];
        failIf(timeline.length < 6, "Expected several timeline items in the synthetic date window.", failures);
        return failures;
      }
    },
    {
      name: "assistant_what_protocol_rules",
      namespaceId: personalNamespaceId,
      promptClass: "what",
      tool: "memory.get_protocols",
      args: {
        namespace_id: personalNamespaceId,
        query: "protocol replay clarification",
        limit: 12
      },
      expectedTerms: ["clarification", "replay"],
      validate: (payload) => {
        const failures: string[] = [];
        const items = Array.isArray(payload?.items) ? payload.items : [];
        failIf(items.length < 2, "Expected active protocol items for replay and clarification.", failures);
        return failures;
      }
    },
    {
      name: "assistant_what_synthetic_poisoned_rule_rejection",
      namespaceId: syntheticNamespaceId,
      promptClass: "what",
      tool: "memory.get_protocols",
      args: {
        namespace_id: syntheticNamespaceId,
        query: "always answer i don't know",
        limit: 8
      },
      validate: (payload) => {
        const failures: string[] = [];
        const items = Array.isArray(payload?.items) ? payload.items : [];
        failIf(items.length !== 0, "Expected no active protocol items for the poisoned one-off instruction.", failures);
        return failures;
      }
    },
    {
      name: "assistant_what_system_health",
      namespaceId: personalNamespaceId,
      promptClass: "what",
      tool: "memory.get_stats",
      args: {
        source_limit: 8
      },
      validate: (payload) => {
        const failures: string[] = [];
        failIf(!payload?.overview?.queueSummary, "Expected queue summary in system stats.", failures);
        failIf(!payload?.runtimeWorkers?.workers?.length, "Expected runtime worker health rows.", failures);
        failIf(!payload?.bootstrap?.progress, "Expected bootstrap progress in system stats.", failures);
        failIf(!Array.isArray(payload?.monitoredSources), "Expected monitored source summaries in system stats.", failures);
        return failures;
      }
    }
  ];
}

async function executeScenario(entry: McpScenario): Promise<McpScenarioResult> {
  const startedAt = performance.now();
  const wrapped = (await executeMcpTool(entry.tool, entry.args)) as { readonly structuredContent?: unknown };
  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  const payload = wrapped?.structuredContent as any;
  const failures: string[] = [];
  const evidence = evidenceItems(payload);
  const confidence = payload?.duality?.confidence as RecallConfidence | undefined;
  const followUpAction = payload?.duality?.followUpAction as string | null | undefined;

  if (entry.expectedTerms) {
    for (const term of entry.expectedTerms) {
      failIf(!hasTerm(payload, term), `missing term ${term}`, failures);
    }
  }

  if (entry.expectedConfidence) {
    failIf(confidence !== entry.expectedConfidence, `confidence ${confidence ?? "n/a"} below expected ${entry.expectedConfidence}`, failures);
  }

  if (entry.expectedFollowUpAction) {
    failIf(followUpAction !== entry.expectedFollowUpAction, `expected follow-up action ${entry.expectedFollowUpAction}, got ${followUpAction ?? "none"}`, failures);
  }

  if (entry.requireEvidence) {
    failIf(evidence.length === 0, "expected duality evidence items", failures);
  }

  if (entry.requireSourceLink) {
    failIf(sourceLinkCount(evidence) === 0, "expected at least one evidence source link", failures);
  }

  if (entry.requireProvenanceAnswer) {
    const provenanceEvidence = Array.isArray(payload?.meta?.provenanceAnswer?.evidence) ? payload.meta.provenanceAnswer.evidence : [];
    failIf(!payload?.meta?.provenanceAnswer, "expected provenanceAnswer for why query", failures);
    failIf(provenanceEvidence.length === 0, "expected provenanceAnswer evidence refs", failures);
  }

  if (entry.validate) {
    failures.push(...entry.validate(payload));
  }

  let followUpToolUsed: string | null = null;
  let followUpPassed: boolean | undefined;
  if (entry.followUpTool) {
    followUpToolUsed = entry.followUpTool.name;
    const followUpWrapped = (await executeMcpTool(entry.followUpTool.name, entry.followUpTool.args)) as { readonly structuredContent?: unknown };
    const followUpPayload = followUpWrapped?.structuredContent as any;
    const followUpFailures: string[] = [];
    if (entry.followUpTool.expectedTerms) {
      for (const term of entry.followUpTool.expectedTerms) {
        failIf(!hasTerm(followUpPayload, term), `follow-up missing term ${term}`, followUpFailures);
      }
    }
    if (typeof entry.followUpTool.minimumItemCount === "number") {
      failIf(
        listCountForTool(entry.followUpTool.name, followUpPayload) < entry.followUpTool.minimumItemCount,
        `follow-up expected at least ${entry.followUpTool.minimumItemCount} items`,
        followUpFailures
      );
    }
    followUpPassed = followUpFailures.length === 0;
    failures.push(...followUpFailures);
  }

  return {
    name: entry.name,
    namespaceId: entry.namespaceId,
    promptClass: entry.promptClass,
    tool: entry.tool,
    latencyMs,
    confidence,
    followUpAction,
    evidenceCount: evidence.length,
    sourceLinkCount: sourceLinkCount(evidence),
    followUpToolUsed,
    followUpPassed,
    passed: failures.length === 0,
    failures
  };
}

function summarize(results: readonly McpScenarioResult[]): McpSmokeBenchmarkReport["summary"] {
  const byPromptClass: Record<McpPromptClass, { passed: number; failed: number }> = {
    who: { passed: 0, failed: 0 },
    what: { passed: 0, failed: 0 },
    where: { passed: 0, failed: 0 },
    when: { passed: 0, failed: 0 },
    why: { passed: 0, failed: 0 }
  };

  let passed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.passed) {
      passed += 1;
      byPromptClass[result.promptClass].passed += 1;
    } else {
      failed += 1;
      byPromptClass[result.promptClass].failed += 1;
    }
  }

  return {
    passed,
    failed,
    byPromptClass
  };
}

function toMarkdown(report: McpSmokeBenchmarkReport): string {
  const lines = [
    "# MCP Assistant Eval Report",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- replayReportPath: ${report.replayReportPath}`,
    `- syntheticWatchReportPath: ${report.syntheticWatchReportPath}`,
    `- passed: ${report.passed}`,
    "",
    "## Summary",
    "",
    `- passed: ${report.summary.passed}`,
    `- failed: ${report.summary.failed}`,
    ""
  ];

  for (const promptClass of ["who", "what", "where", "when", "why"] as const) {
    const summary = report.summary.byPromptClass[promptClass];
    lines.push(`- ${promptClass}: ${summary.passed} passed / ${summary.failed} failed`);
  }

  lines.push("", "## Results", "");
  for (const result of report.results) {
    lines.push(
      `- ${result.name}: ${result.passed ? "pass" : "fail"} | class=${result.promptClass} | tool=\`${result.tool}\` | confidence=${result.confidence ?? "n/a"} | evidence=${result.evidenceCount} | sourceLinks=${result.sourceLinkCount} | latency=${result.latencyMs}ms`
    );
    if (result.followUpToolUsed) {
      lines.push(`  - follow-up: ${result.followUpToolUsed} (${result.followUpPassed ? "pass" : "fail"})`);
    }
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runAndWriteMcpSmokeBenchmark(
  personalNamespaceId = "personal",
  syntheticNamespaceId = "synthetic_human_sandbox",
  omiNamespaceId = "omi_sandbox"
): Promise<{
  readonly report: McpSmokeBenchmarkReport;
  readonly output: {
    readonly jsonPath: string;
    readonly markdownPath: string;
  };
}> {
  const replay = await runAndWriteLifeReplayBenchmark();
  const synthetic = await runAndWriteHumanSyntheticWatchBenchmark();
  const omi = await runAndWriteOmiWatchSmokeBenchmark();
  const results: McpScenarioResult[] = [];

  for (const entry of scenarios(personalNamespaceId, syntheticNamespaceId, omiNamespaceId)) {
    results.push(await executeScenario(entry));
  }

  const report: McpSmokeBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    replayReportPath: replay.output.jsonPath,
    syntheticWatchReportPath: synthetic.output.jsonPath,
    omiWatchReportPath: omi.output.jsonPath,
    results,
    summary: summarize(results),
    passed: results.every((item) => item.passed)
  };

  const outDir = outputDir();
  await mkdir(outDir, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outDir, `mcp-smoke-${timestamp}.json`);
  const markdownPath = path.join(outDir, `mcp-smoke-${timestamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  return {
    report,
    output: {
      jsonPath,
      markdownPath
    }
  };
}

export async function runMcpSmokeBenchmarkCli(): Promise<void> {
  try {
    const result = await runAndWriteMcpSmokeBenchmark();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closePool();
  }
}
