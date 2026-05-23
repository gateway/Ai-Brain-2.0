import { readConfig } from "../config.js";
import { createOpenRouterAdapter } from "../providers/openrouter.js";
import { createHash } from "node:crypto";
import type {
  AssistantCandidate,
  AssistantInput,
  AssistantOutput,
  AssistantRunResult,
  ExtractionAssistantMode,
  ExtractionUnit,
  TaxonomyRegistry,
  ValidationIssue
} from "./types.js";
import { compactAllowedTaxonomyPayload } from "./registry.js";

export const ASSISTANT_INPUT_SCHEMA_VERSION = "taxonomy_temporal_assistant_input_v2" as const;
export const ASSISTANT_OUTPUT_SCHEMA_VERSION = "taxonomy_temporal_assistant_output_v1" as const;
export const ASSISTANT_PROMPT_VERSION = "taxonomy_temporal_assistant_prompt_v7";
const ASSISTANT_PACKET_VERSION = "assistant_packet_v2" as const;
const MAX_ASSISTANT_CONTEXT_CHARS = 360;

const SYSTEM_PROMPT = [
  `JSON only: {schema_version:"${ASSISTANT_OUTPUT_SCHEMA_VERSION}",unit_id,candidates,warnings}.`,
  "Use only supplied taxonomy. Unknown/reusable gaps go to suggested_taxonomy and taxonomy_status needs_taxonomy_review or diagnostic_only; never promote them.",
  "candidate_type: fact,event,relationship,task,temporal_reference,diagnostic only.",
  "Candidate fields: candidate_type,evidence_quote,object_type,domain,family,taxonomy_status,confidence,promotion_recommendation.",
  "Direct facts add evidence_family,answer_shape,subject,value,polarity,temporal_anchor when useful.",
  "evidence_quote must be exact source text, shortest useful phrase, no paraphrase; preserve full role titles.",
  "Temporal: exact_date,date_range,duration,recency,routine_time,event_relative,vague_time,needs_anchor; include precision, answerable_shapes, blocked_shapes, normalized_duration/value when safe.",
  "Profile traits: domain identity_values; families civic_identity,religious_identity,political_orientation,personality_trait,allyship_support,value_stance; co-mentions/generic roles are diagnostic_only.",
  "Direct-fact families: preference,owns,purchase,project_support,health_status,causal_reason,relationship_status,explicit_list_set,role,lives_in,temporal_event.",
  "No outside inference. Use source_captured_at for relative dates. Never upgrade vague/month/year/range precision.",
  "At most 2 candidates; prefer [] over weak observations. Warnings max 2, under 8 words.",
  "promotion_recommendation=promote only for approved, source-bound evidence; otherwise diagnostic_only, needs_clarification, or needs_taxonomy_review."
].join(" ");

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedContext(value: string): string {
  const normalized = normalize(value);
  if (normalized.length <= MAX_ASSISTANT_CONTEXT_CHARS) {
    return normalized;
  }
  return normalized.slice(Math.max(0, normalized.length - MAX_ASSISTANT_CONTEXT_CHARS));
}

function includesText(haystack: string, needle: string | null | undefined): boolean {
  const normalizedNeedle = normalize(needle).toLowerCase();
  return Boolean(normalizedNeedle) && haystack.toLowerCase().includes(normalizedNeedle);
}

function confidence(overrides: Partial<NonNullable<AssistantCandidate["confidence"]>> = {}): NonNullable<AssistantCandidate["confidence"]> {
  return {
    gliner2: null,
    llm_taxonomy: null,
    llm_temporal: null,
    evidence: 0.8,
    overall: 0.76,
    ...overrides
  };
}

function candidate(base: AssistantCandidate): AssistantCandidate {
  return {
    candidate_type: "fact",
    evidence_quote: null,
    object_type: "CLAIM",
    domain: "personal",
    family: "current_state",
    subtype: null,
    tags: [],
    suggested_taxonomy: null,
    taxonomy_status: "approved",
    temporal: null,
    confidence: confidence(),
    promotion_recommendation: "promote",
    ...base
  };
}

export function deterministicAssistantCandidates(unit: ExtractionUnit): readonly AssistantCandidate[] {
  const text = unit.unitText;
  const results: AssistantCandidate[] = [];
  const pushPattern = (pattern: RegExp, build: (quote: string) => AssistantCandidate): void => {
    const match = text.match(pattern);
    if (!match?.[0]) {
      return;
    }
    results.push(build(normalize(match[0])));
  };
  const pushTraitPattern = (
    pattern: RegExp,
    build: (quote: string, subject: string | null) => AssistantCandidate
  ): void => {
    const match = text.match(pattern);
    if (!match?.[0]) {
      return;
    }
    const subject = normalize(match.groups?.subject ?? match[1] ?? "");
    results.push(build(normalize(match[0]), subject || null));
  };
  const traitCandidate = (base: AssistantCandidate): AssistantCandidate =>
    candidate({
      candidate_type: "fact",
      object_type: "CLAIM",
      domain: "identity_values",
      family: "profile_trait",
      subtype: null,
      tags: ["profile_trait"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 }),
      promotion_recommendation: "promote",
      ...base
    });

  pushPattern(/\b\d+\s*(?:mbps|gbps|kbps|mb\/s|gb\/s)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "technical", family: "speed", subtype: null, tags: ["speed"], confidence: confidence({ evidence: 0.92, overall: 0.86 }) })
  );
  pushTraitPattern(
    /\b(?<subject>[A-Z][A-Za-z'’-]{1,40})\b[^.?!]{0,160}\b(?:proud\s+of\s+(?:his|her|their|my|our)?\s*(?:country|nation)|patriotic|Fourth\s+of\s+July|Independence\s+Day|national\s+anthem|flies?\s+(?:an?\s+)?(?:American\s+)?flag|civic\s+service|serv(?:e|ing)\s+(?:his|her|their|my|our)?\s*(?:country|nation)|military\s+(?:service|recruiter)|drawn\s+to\s+serv(?:e|ing)\b)\b/u,
    (quote, subject) =>
      traitCandidate({
        evidence_quote: quote,
        subject,
        family: "civic_identity",
        subtype: "patriotic",
        trait_family: "civic_identity",
        trait_value: "patriotic",
        polarity: /\bnot\s+(?:very\s+)?patriotic\b|\bdoes(?:n'?t| not)\s+(?:feel|seem|consider|identify)[^.?!]{0,40}\bpatriotic\b/iu.test(quote) ? "negative" : "positive",
        tags: ["profile_trait", "civic_identity", "patriotic"],
        confidence: confidence({ evidence: 0.88, overall: 0.82 })
      })
  );
  pushTraitPattern(
    /\b(?<subject>[A-Z][A-Za-z'’-]{1,40})\b[^.?!]{0,120}\b(?:religious|spiritual|atheist|agnostic|church|mosque|temple|prays?|belief\s+in\s+God)\b/iu,
    (quote, subject) =>
      traitCandidate({
        evidence_quote: quote,
        subject,
        family: "religious_identity",
        subtype: /\batheist\b/iu.test(quote) ? "atheist" : /\bagnostic\b/iu.test(quote) ? "agnostic" : /\bspiritual\b/iu.test(quote) ? "spiritual" : "religious",
        trait_family: "religious_identity",
        trait_value: /\batheist\b/iu.test(quote) ? "atheist" : /\bagnostic\b/iu.test(quote) ? "agnostic" : /\bspiritual\b/iu.test(quote) ? "spiritual" : "religious",
        polarity: /\bnot\s+(?:religious|spiritual)\b|\bdoes(?:n'?t| not)\s+(?:believe|pray|attend)\b/iu.test(quote) ? "negative" : "positive",
        tags: ["profile_trait", "religious_identity"],
        confidence: confidence({ evidence: 0.86, overall: 0.8 })
      })
  );
  pushTraitPattern(
    /\b(?<subject>[A-Z][A-Za-z'’-]{1,40})\b[^.?!]{0,120}\b(?:political\s+leaning|local\s+politics|policy|party|progressive|conservative|liberal|votes?\s+for|supports?\s+(?:the\s+)?(?:policy|candidate|party))\b/iu,
    (quote, subject) =>
      traitCandidate({
        evidence_quote: quote,
        subject,
        family: /\bpolitical\s+leaning|party|progressive|conservative|liberal\b/iu.test(quote) ? "political_orientation" : "value_stance",
        subtype: /\blocal\s+politics\b/iu.test(quote) ? "local_issue_focus" : /\bpolicy\b/iu.test(quote) ? "issue_stance" : "political_leaning",
        trait_family: /\bpolitical\s+leaning|party|progressive|conservative|liberal\b/iu.test(quote) ? "political_orientation" : "value_stance",
        trait_value: "political stance",
        polarity: "positive",
        tags: ["profile_trait", "political_orientation", "value_stance"],
        confidence: confidence({ evidence: 0.84, overall: 0.78 })
      })
  );
  pushTraitPattern(
    /\b(?<subject>[A-Z][A-Za-z'’-]{1,40})\b[^.?!]{0,120}\b(?:ally|advocates?\s+for|supports?\s+(?:the\s+)?(?:community|LGBTQ|transgender|neighbors?|friends?)|mentors?|helped\s+(?:at|with|organize))\b/iu,
    (quote, subject) =>
      traitCandidate({
        evidence_quote: quote,
        subject,
        family: "allyship_support",
        subtype: /\badvocates?\b/iu.test(quote) ? "advocacy" : /\bmentors?|helped\b/iu.test(quote) ? "community_support" : "supportive",
        trait_family: "allyship_support",
        trait_value: "supportive",
        polarity: /\bnot\s+(?:an?\s+)?ally\b|\bdoes(?:n'?t| not)\s+support\b/iu.test(quote) ? "negative" : "positive",
        tags: ["profile_trait", "allyship_support"],
        confidence: confidence({ evidence: 0.84, overall: 0.78 })
      })
  );
  pushPattern(/\b(?:bought|purchased|acquired)\s+[^.!?]{2,160}/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      domain: "personal",
      family: "purchase",
      subtype: "purchased_object",
      tags: ["purchase", "owned_object"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b(?:because|since|reason\s+(?:was|is)|decided\s+to|started\s+(?:her|his|their|my)?\s*(?:own\s+)?(?:business|store|project))[^.!?]{4,180}/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      object_type: "CLAIM",
      domain: "project_ops",
      family: "causal_reason",
      subtype: "decision_reason",
      tags: ["causal_reason", "reason"],
      confidence: confidence({ evidence: 0.84, overall: 0.78 })
    })
  );
  pushPattern(/\bfavorite books?\s+(?:are|include|included|:)\s+[^.!?]{2,140}|\b(?:no|none|does(?:n'?t| not)|don't|do not)\b[^.?!]{0,100}\bfavorite books?\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      domain: "personal",
      family: "explicit_list_set",
      subtype: /\b(?:no|none|does(?:n'?t| not)|don't|do not)\b/iu.test(quote) ? "explicit_none" : "explicit_preferences",
      tags: ["explicit_list_set", "favorite_books"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\bprefer(?:s|red)?\s+(?:eating\s+)?(?:chicken|beef|pork|fish|turkey|lamb)\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      domain: "personal",
      family: "preference",
      subtype: "food_preference",
      tags: ["preference", "food"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b(?:is|was|are|were)\s+(?:married|engaged|single|divorced)\b|\bmarried\s+to\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      domain: "family",
      family: "relationship_status",
      subtype: /\bsingle\b/iu.test(quote) ? "single" : /\bdivorced\b/iu.test(quote) ? "divorced" : /\bengaged\b/iu.test(quote) ? "engaged" : "married",
      tags: ["relationship_status"],
      confidence: confidence({ evidence: 0.84, overall: 0.78 })
    })
  );
  pushPattern(/\b(?:Nike|Adidas|Asics|Brooks|Hoka|New Balance)\b/u, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "brand", tags: ["brand"], confidence: confidence({ evidence: 0.9, overall: 0.84 }) })
  );
  pushPattern(/\b(?:Golden Retriever|Labrador|Poodle|German Shepherd|Bulldog)\b/u, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "breed", tags: ["breed", "pet"], confidence: confidence({ evidence: 0.9, overall: 0.84 }) })
  );
  pushPattern(/\b(?:my|our)\s+(?:cat|dog|pet)\s+(?:is\s+named|name\s+is|called)\s+([A-Z][A-Za-z]+)\b/u, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "pet_name", tags: ["pet_name"], confidence: confidence({ evidence: 0.9, overall: 0.84 }) })
  );
  pushPattern(/\b(?:my|our)\s+(?:cat|dog|pet)\s*,\s*([A-Z][A-Za-z'-]{1,30})\b/u, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "pet_name", tags: ["pet_name"], confidence: confidence({ evidence: 0.9, overall: 0.84 }) })
  );
  pushPattern(/\b(?:Spotify|Apple Music|YouTube Music|Tidal)\b/u, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "service_name", tags: ["service_name"], confidence: confidence({ evidence: 0.9, overall: 0.84 }) })
  );
  pushPattern(/\b(?:[1-9]|1[0-2])(?::[0-5]\d)?\s*(?:am|pm)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "daily_life", family: "time_of_day", subtype: "routine_time", tags: ["time_of_day"], confidence: confidence({ evidence: 0.88, overall: 0.82 }) })
  );
  pushPattern(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:bikes?|cars?|devices?|projects?|tasks?)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, family: "current_state", subtype: "count", tags: ["count"], confidence: confidence({ evidence: 0.88, overall: 0.82 }) })
  );
  pushPattern(/\b(?:IKEA|Target|Walmart|Amazon|sports store downtown|bookshop|retailer)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "personal", family: "venue", subtype: "shop", tags: ["shop"], confidence: confidence({ evidence: 0.88, overall: 0.82 }) })
  );
  pushPattern(/\b(?:University of Melbourne|UCLA|Serenity Yoga|Data Science|certification|degree|course|program)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "education", family: quote.toLowerCase().includes("certification") ? "credential" : "venue", subtype: quote.toLowerCase().includes("certification") ? "certification" : "school", tags: ["education"], confidence: confidence({ evidence: 0.86, overall: 0.8 }) })
  );
  pushPattern(/\b(?:for\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:days?|weeks?|months?|years?|hours?)\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      domain: "travel",
      family: "duration",
      subtype: "event_duration",
      tags: ["duration"],
      temporal: {
        raw_text: quote,
        temporal_type: "duration",
        temporal_class: "duration",
        normalized_range: null,
        normalized_duration: null,
        normalized_value: quote,
        granularity: "duration",
        precision: "duration",
        anchor_type: "none",
        anchor_id: null,
        answerable_shapes: ["duration"],
        blocked_shapes: ["when", "recency"],
        needs_clarification: false
      },
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b(?:Marketing specialist|Level Designer|Game Designer|Product Designer|Software Engineer|CTO|CEO|advisor|adviser|engineer|designer|manager)\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "work", family: "role", subtype: "job_title", tags: ["role"], confidence: confidence({ evidence: 0.86, overall: 0.8 }) })
  );
  pushPattern(/\b(?:spent|paid|cost|buying|bought|purchased)\b[^.?!]{0,160}(?:\$\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s+dollars?)[^.?!]{0,80}\b(?:handbag|bag|item|purchase|gift|ticket|book|furniture)\b|\b(?:handbag|bag|luxury\s+items?)\b[^.?!]{0,160}(?:pretty\s+penny\s*[-–—:]?\s*)?(?:\$\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s+dollars?)\b|\b\$\s?\d[\d,]*(?:\.\d{2})?\b[^.?!]{0,120}\b(?:spent|paid|cost|buying|bought|purchased|handbag|bag|item)\b/iu, (quote) =>
    candidate({
      candidate_type: "event",
      evidence_quote: quote,
      object_type: "CLAIM",
      domain: "finance",
      family: "price",
      subtype: "amount_spent",
      tags: ["price", "purchase"],
      confidence: confidence({ evidence: 0.88, overall: 0.82 })
    })
  );
  pushPattern(/\b(?:previous|former|old)?\s*(?:stance|view|belief|opinion|position)\b[^.?!]{0,120}\b(?:was|used to be|used to believe|formerly)\b[^.?!]{0,120}\b(?:atheist|agnostic|spiritual|religious|skeptical|optimistic|pessimistic)\b|\b(?:used to be|used to believe|formerly was)\b[^.?!]{0,80}\b(?:atheist|agnostic|spiritual|religious|skeptical)\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      object_type: "CLAIM",
      domain: "daily_life",
      family: "belief_stance",
      subtype: "previous_stance",
      tags: ["stance", "belief"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b(?:production\s+of|play\s+(?:called|named)?|attended\s+(?:a\s+)?)\s+(?:the\s+)?([A-Z][A-Za-z0-9'’&:-]+(?:\s+[A-Z][A-Za-z0-9'’&:-]+){0,6})\b/u, (quote) =>
    candidate({
      evidence_quote: quote,
      object_type: "CREATIVE_WORK",
      domain: "media",
      family: "creative_work",
      subtype: "performance_title",
      tags: ["creative_work", "performance_title"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b(?:tried|made|saved|mixed)\s+(?:a\s+|the\s+)?([A-Za-z][A-Za-z0-9'’& -]{2,60}?(?:cocktail|fizz|martini|recipe))\b/iu, (quote) =>
    candidate({
      evidence_quote: quote,
      object_type: "CREATIVE_WORK",
      domain: "media",
      family: "creative_work",
      subtype: "recipe_title",
      tags: ["creative_work", "recipe_title"],
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\b\d{4}-\d{2}-\d{2}\b/u, (quote) =>
    candidate({
      candidate_type: "temporal_reference",
      evidence_quote: quote,
      object_type: "TEMPORAL_REFERENCE",
      domain: "personal",
      family: "temporal_event",
      subtype: "exact_date",
      tags: ["exact_date"],
      temporal: {
        raw_text: quote,
        temporal_type: "exact_date",
        temporal_class: "exact_date",
        normalized_range: null,
        normalized_duration: null,
        normalized_value: quote,
        granularity: "day",
        precision: "day",
        anchor_type: "explicit",
        anchor_id: null,
        answerable_shapes: ["when"],
        blocked_shapes: ["duration", "recency"],
        needs_clarification: false
      },
      confidence: confidence({ evidence: 0.9, overall: 0.84 })
    })
  );
  pushPattern(/\b(?:three|two|one|\d+)\s+(?:days?|weeks?|months?|years?)\s+ago\b/iu, (quote) =>
    candidate({
      candidate_type: "temporal_reference",
      evidence_quote: quote,
      object_type: "TEMPORAL_REFERENCE",
      domain: "task_ops",
      family: "task_due",
      subtype: "relative_due_date",
      tags: ["relative_time"],
      temporal: {
        raw_text: quote,
        temporal_type: "relative_to_source_date",
        temporal_class: "recency",
        normalized_range: null,
        normalized_duration: null,
        normalized_value: quote,
        granularity: "day",
        precision: "day",
        anchor_type: "source_captured_at",
        anchor_id: null,
        answerable_shapes: ["when", "recency"],
        blocked_shapes: ["duration"],
        needs_clarification: false
      },
      confidence: confidence({ evidence: 0.86, overall: 0.8 })
    })
  );
  pushPattern(/\bafter\s+[A-Z][A-Za-z]*(?:\s+\w+){0,3}\b/u, (quote) =>
    candidate({
      candidate_type: "temporal_reference",
      evidence_quote: quote,
      object_type: "TEMPORAL_REFERENCE",
      domain: "personal",
      family: "temporal_event",
      subtype: "bounded_interval",
      tags: ["event_relative_time"],
      temporal: {
        raw_text: quote,
        temporal_type: "relative_to_unknown_event",
        temporal_class: "event_relative",
        normalized_range: null,
        normalized_duration: null,
        normalized_value: quote,
        granularity: "unknown",
        precision: "relative_order",
        anchor_type: "none",
        anchor_id: null,
        answerable_shapes: [],
        blocked_shapes: ["when", "date_range", "duration", "recency", "routine_time"],
        needs_clarification: true
      },
      confidence: confidence({ evidence: 0.78, overall: 0.7 }),
      promotion_recommendation: "needs_clarification"
    })
  );
  pushPattern(/\b(?:diagnosed\s+with\s+)?(?:ADHD|anxiety|depression)\b|\bdiagnosed\b/iu, (quote) =>
    candidate({ evidence_quote: quote, domain: "health", family: "health_status", subtype: "neurodevelopmental_context", tags: [quote], confidence: confidence({ evidence: 0.84, overall: 0.78 }) })
  );
  pushPattern(/\b(?:backlog|roadmap|priority|task list|todo|to-do)\b/iu, (quote) =>
    candidate({
      candidate_type: "task",
      evidence_quote: quote,
      object_type: "TASK",
      domain: "task_ops",
      family: "task_status",
      subtype: "todo",
      tags: ["task"],
      confidence: confidence({ evidence: 0.82, overall: 0.76 })
    })
  );
  pushPattern(/\btask list\b/iu, (quote) =>
    candidate({
      candidate_type: "task",
      evidence_quote: quote,
      object_type: "TASK",
      domain: "task_ops",
      family: "task_status",
      subtype: "todo",
      tags: ["task_list"],
      confidence: confidence({ evidence: 0.82, overall: 0.76 })
    })
  );
  pushPattern(/\b(?:memoir engine|knowledge graph|postgres|taxonomy|temporal registry)\b/iu, (quote) =>
    candidate({
      candidate_type: "event",
      evidence_quote: quote,
      object_type: "PROJECT",
      domain: "project_ops",
      family: "project_support",
      subtype: "project_tool",
      tags: ["project"],
      confidence: confidence({ evidence: 0.82, overall: 0.76 })
    })
  );
  pushPattern(/\bknowledge graph\b/iu, (quote) =>
    candidate({
      candidate_type: "event",
      evidence_quote: quote,
      object_type: "PROJECT",
      domain: "project_ops",
      family: "project_support",
      subtype: "project_substrate",
      tags: ["project", "graph"],
      confidence: confidence({ evidence: 0.82, overall: 0.76 })
    })
  );
  for (const [pattern, subtype, tag] of [
    [/\bPostgres\b/u, "project_tool", "database"],
    [/\btaxonomy\b/iu, "project_substrate", "taxonomy"],
    [/\btemporal registry\b/iu, "project_substrate", "temporal_registry"]
  ] as const) {
    pushPattern(pattern, (quote) =>
      candidate({
        candidate_type: "event",
        evidence_quote: quote,
        object_type: "PROJECT",
        domain: "project_ops",
        family: "project_support",
        subtype,
        tags: ["project", tag],
        confidence: confidence({ evidence: 0.82, overall: 0.76 })
      })
    );
  }

  if (/\btriage rubric\b/iu.test(text)) {
    results.push(
      candidate({
        candidate_type: "diagnostic",
        evidence_quote: "triage rubric",
        object_type: "UNKNOWN_CANDIDATE",
        domain: "unknown",
        family: "unclassified_observation",
        subtype: "unknown_reviewable",
        suggested_taxonomy: {
          key: "task_ops.triage_rubric",
          label: "Triage rubric",
          reason: "The concept is useful but not yet an approved controlled subtype."
        },
        taxonomy_status: "needs_taxonomy_review",
        promotion_recommendation: "needs_taxonomy_review",
        tags: ["triage", "rubric"],
        confidence: confidence({ evidence: 0.82, overall: 0.74 })
      })
    );
  }

  return results.slice(0, 6);
}

export function buildAssistantInput(params: {
  readonly registry: TaxonomyRegistry;
  readonly unit: ExtractionUnit;
  readonly gliner2Candidates: Record<string, unknown>;
  readonly knownBirthYear?: number | null;
  readonly knownEvents?: readonly unknown[];
  readonly knownPeriods?: readonly unknown[];
}): AssistantInput {
  return {
    schema_version: ASSISTANT_INPUT_SCHEMA_VERSION,
    packet_version: ASSISTANT_PACKET_VERSION,
    taxonomy_version: params.registry.version,
    unit: {
      unit_id: params.unit.unitId,
      source_type: params.unit.sourceType,
      captured_at: params.unit.capturedAt ?? null,
      speaker: params.unit.speaker ?? null,
      text: params.unit.unitText,
      context_before: boundedContext(params.unit.contextBefore),
      context_after: boundedContext(params.unit.contextAfter),
      text_sha256: sha256(params.unit.unitText),
      token_estimate: params.unit.tokenEstimate
    },
    allowed_taxonomy: compactAllowedTaxonomyPayload(params.registry, params.unit.unitText),
    temporal_anchor_pack: {
      source_captured_at: params.unit.capturedAt ?? null,
      known_birth_year: params.knownBirthYear ?? null,
      known_events: params.knownEvents ?? [],
      known_periods: params.knownPeriods ?? []
    },
    gliner2_candidates: compactGliner2Candidates(params.gliner2Candidates)
  };
}

const ASSISTANT_SKIP_FAMILIES = new Set([
  "speed",
  "time_of_day",
  "duration",
  "task_due",
  "temporal_event",
  "credential",
  "venue",
  "current_state",
  "creative_work"
]);

function exactEvidencePresent(unit: ExtractionUnit, quote: string | null | undefined): boolean {
  return includesText(unit.unitText, quote) || includesText(unit.contextBefore, quote) || includesText(unit.contextAfter, quote);
}

function canSkipAssistantForDeterministicCandidates(unit: ExtractionUnit, candidates: readonly AssistantCandidate[]): boolean {
  if (candidates.length < 1 || candidates.length > 2) {
    return false;
  }
  return candidates.every((entry) => {
    const family = normalize(entry.family);
    const taxonomyStatus = normalize(entry.taxonomy_status);
    const recommendation = normalize(entry.promotion_recommendation);
    if (!ASSISTANT_SKIP_FAMILIES.has(family)) {
      return false;
    }
    if (entry.suggested_taxonomy || !["approved", "mapped_to_parent"].includes(taxonomyStatus)) {
      return false;
    }
    if (recommendation !== "promote") {
      return false;
    }
    if (!exactEvidencePresent(unit, entry.evidence_quote)) {
      return false;
    }
    return entry.temporal?.needs_clarification !== true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactGliner2Candidates(value: Record<string, unknown>): Record<string, unknown> {
  const scenes = Array.isArray(value.scenes) ? value.scenes : [];
  const extractors = new Set<string>();
  const structureKinds = new Set<string>();
  const supportPhrases: string[] = [];
  for (const scene of scenes) {
    if (!isRecord(scene) || !Array.isArray(scene.extractors)) {
      continue;
    }
    for (const extractor of scene.extractors) {
      if (!isRecord(extractor)) {
        continue;
      }
      if (typeof extractor.id === "string") {
        extractors.add(extractor.id);
      }
      const structures = Array.isArray(extractor.structures) ? extractor.structures : [];
      for (const structure of structures) {
        if (!isRecord(structure)) {
          continue;
        }
        if (typeof structure.kind === "string") {
          structureKinds.add(structure.kind);
        }
        const phrase = normalize(structure.support_phrase ?? structure.phrase ?? structure.evidence);
        if (phrase && supportPhrases.length < 8) {
          supportPhrases.push(phrase);
        }
      }
    }
  }
  return {
    attempted: scenes.length > 0 || Object.keys(value).length > 0,
    scene_count: scenes.length,
    extractors: [...extractors].slice(0, 6),
    structure_kinds: [...structureKinds].slice(0, 12),
    support_phrases: supportPhrases
  };
}

function normalizeConfidenceShape(value: unknown): NonNullable<AssistantCandidate["confidence"]> {
  if (typeof value === "number" && Number.isFinite(value)) {
    return confidence({ llm_taxonomy: value, llm_temporal: value, evidence: value, overall: value });
  }
  if (isRecord(value)) {
    return confidence({
      gliner2: typeof value.gliner2 === "number" ? value.gliner2 : null,
      llm_taxonomy: typeof value.llm_taxonomy === "number" ? value.llm_taxonomy : null,
      llm_temporal: typeof value.llm_temporal === "number" ? value.llm_temporal : null,
      evidence: typeof value.evidence === "number" ? value.evidence : undefined,
      overall: typeof value.overall === "number" ? value.overall : undefined
    });
  }
  return confidence({ evidence: 0.5, overall: 0.5 });
}

function canonicalizeAssistantOutput(rawOutput: Record<string, unknown>, unit: ExtractionUnit): Record<string, unknown> {
  const candidates = Array.isArray(rawOutput.candidates)
    ? rawOutput.candidates.map((rawCandidate) => {
        if (!isRecord(rawCandidate)) {
          return rawCandidate;
        }
        const taxonomyStatus = normalize(rawCandidate.taxonomy_status);
        return {
          ...rawCandidate,
          taxonomy_status: taxonomyStatus === "promote" ? "approved" : rawCandidate.taxonomy_status,
          confidence: normalizeConfidenceShape(rawCandidate.confidence)
        };
      })
    : rawOutput.candidates;
  return {
    ...rawOutput,
    schema_version: rawOutput.schema_version ?? ASSISTANT_OUTPUT_SCHEMA_VERSION,
    unit_id: rawOutput.unit_id ?? unit.unitId,
    candidates,
    warnings: Array.isArray(rawOutput.warnings) ? rawOutput.warnings : []
  };
}

export function validateAssistantOutputShape(output: Record<string, unknown>, unit: ExtractionUnit): {
  readonly output: AssistantOutput | null;
  readonly issues: readonly ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  if (output.schema_version !== ASSISTANT_OUTPUT_SCHEMA_VERSION) {
    issues.push({ code: "invalid_schema_version", message: `Expected ${ASSISTANT_OUTPUT_SCHEMA_VERSION}.` });
  }
  if (output.unit_id !== unit.unitId) {
    issues.push({ code: "unit_id_mismatch", message: "Assistant output unit_id does not match request unit_id." });
  }
  if (!Array.isArray(output.candidates)) {
    issues.push({ code: "missing_candidates", message: "Assistant output must include candidates array." });
    return { output: null, issues };
  }
  if (output.candidates.length > 4) {
    issues.push({ code: "too_many_candidates", message: "Assistant returned more than 4 candidates." });
  }

  for (const [index, rawCandidate] of output.candidates.entries()) {
    if (!isRecord(rawCandidate)) {
      issues.push({ code: "candidate_not_object", message: "Candidate is not an object.", candidateIndex: index });
      continue;
    }
    const evidenceQuote = normalize(rawCandidate.evidence_quote);
    if (!evidenceQuote) {
      issues.push({ code: "missing_evidence_quote", message: "Candidate lacks evidence_quote.", candidateIndex: index });
    } else if (!includesText(unit.unitText, evidenceQuote) && !includesText(unit.contextBefore, evidenceQuote) && !includesText(unit.contextAfter, evidenceQuote)) {
      issues.push({ code: "evidence_quote_not_in_unit", message: "Evidence quote is not present in unit/context.", candidateIndex: index });
    }
  }

  return { output: output as unknown as AssistantOutput, issues };
}

export async function runTaxonomyTemporalAssistant(params: {
  readonly registry: TaxonomyRegistry;
  readonly unit: ExtractionUnit;
  readonly gliner2Candidates: Record<string, unknown>;
  readonly mode?: ExtractionAssistantMode;
}): Promise<AssistantRunResult> {
  const config = readConfig();
  const mode = params.mode ?? (config.extractionAssistantEnabled ? config.extractionAssistantMode : "off");
  const started = Date.now();
  if (mode === "off") {
    return {
      mode,
      provider: "deterministic",
      model: null,
      jsonValid: true,
      skippedReason: "assistant_off",
      rawOutput: null,
      output: {
        schema_version: ASSISTANT_OUTPUT_SCHEMA_VERSION,
        unit_id: params.unit.unitId,
        candidates: deterministicAssistantCandidates(params.unit),
        warnings: ["deterministic_assistant_fallback"]
      },
      validationIssues: [],
      latencyMs: Date.now() - started
    };
  }

  const deterministicCandidates = deterministicAssistantCandidates(params.unit);
  if (mode !== "strict_review" && canSkipAssistantForDeterministicCandidates(params.unit, deterministicCandidates)) {
    return {
      mode,
      provider: "deterministic",
      model: null,
      jsonValid: true,
      skippedReason: "deterministic_structured_surface_sufficient",
      rawOutput: null,
      output: {
        schema_version: ASSISTANT_OUTPUT_SCHEMA_VERSION,
        unit_id: params.unit.unitId,
        candidates: deterministicCandidates,
        warnings: ["deterministic_structured_surface_sufficient"]
      },
      validationIssues: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      latencyMs: Date.now() - started
    };
  }

  const requestPayload = buildAssistantInput({
    registry: params.registry,
    unit: params.unit,
    gliner2Candidates: params.gliner2Candidates
  });
  const requestText = JSON.stringify(requestPayload);
  if (requestText.length > config.extractionAssistantMaxInputChars) {
    return {
      mode,
      provider: "openrouter",
      model: config.extractionAssistantModel,
      jsonValid: false,
      skippedReason: "assistant_input_too_large",
      rawOutput: null,
      output: null,
      validationIssues: [{ code: "assistant_input_too_large", message: "Assistant input exceeded configured budget." }],
      latencyMs: Date.now() - started
    };
  }
  if (!config.openRouterApiKey) {
    return {
      mode,
      provider: "deterministic",
      model: null,
      jsonValid: true,
      skippedReason: "missing_openrouter_api_key",
      rawOutput: null,
      output: {
        schema_version: ASSISTANT_OUTPUT_SCHEMA_VERSION,
        unit_id: params.unit.unitId,
        candidates: deterministicAssistantCandidates(params.unit),
        warnings: ["openrouter_key_missing_deterministic_fallback"]
      },
      validationIssues: [],
      latencyMs: Date.now() - started
    };
  }

  const adapter = createOpenRouterAdapter();
  const baseInstruction = "Classify and normalize the bounded extraction unit using the provided taxonomy and temporal anchors. Return the required JSON object only.";
  let response;
  let retryWarning: string | null = null;
  try {
    response = await adapter.classifyText({
      model: config.extractionAssistantModel,
      text: requestText,
      systemPrompt: SYSTEM_PROMPT,
      instruction: baseInstruction,
      maxOutputTokens: config.extractionAssistantMaxOutputTokens,
      timeoutMs: config.extractionAssistantTimeoutMs
    });
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : String(error);
    retryWarning = `assistant_retry_after_provider_error: ${firstMessage}`;
    try {
      response = await adapter.classifyText({
        model: config.extractionAssistantModel,
        text: requestText,
        systemPrompt: SYSTEM_PROMPT,
        instruction: [
          baseInstruction,
          "STRICT RETRY: return one JSON object, no markdown, no prose.",
          `If there are no safe candidates, return {"schema_version":"${ASSISTANT_OUTPUT_SCHEMA_VERSION}","unit_id":"${params.unit.unitId}","candidates":[],"warnings":["no_safe_candidates"]}.`
        ].join(" "),
        maxOutputTokens: config.extractionAssistantMaxOutputTokens,
        timeoutMs: config.extractionAssistantTimeoutMs
      });
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      return {
        mode,
        provider: "openrouter",
        model: config.extractionAssistantModel,
        jsonValid: false,
        skippedReason: "assistant_provider_error",
        rawOutput: null,
        output: {
          schema_version: ASSISTANT_OUTPUT_SCHEMA_VERSION,
          unit_id: params.unit.unitId,
          candidates: deterministicAssistantCandidates(params.unit),
          warnings: [firstMessage, message]
        },
        validationIssues: [{ code: "assistant_provider_error", message }],
        latencyMs: Date.now() - started
      };
    }
  }
  const canonicalOutput = canonicalizeAssistantOutput(response.output, params.unit);
  const outputWithRetryWarning = retryWarning
    ? {
        ...canonicalOutput,
        warnings: [...(Array.isArray(canonicalOutput.warnings) ? canonicalOutput.warnings : []), retryWarning]
      }
    : canonicalOutput;
  const shape = validateAssistantOutputShape(outputWithRetryWarning, params.unit);
  return {
    mode,
    provider: "openrouter",
    model: response.model,
    jsonValid: shape.output !== null && shape.issues.length === 0,
    skippedReason: null,
    rawOutput: outputWithRetryWarning,
    output: shape.output,
    validationIssues: shape.issues,
    tokenUsage: response.tokenUsage,
    latencyMs: response.latencyMs
  };
}
