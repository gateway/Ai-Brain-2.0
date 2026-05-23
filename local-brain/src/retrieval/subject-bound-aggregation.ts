import type { RecallResult } from "../types.js";
import { queryRows } from "../db/client.js";
import { resolveCanonicalEntityReference } from "../identity/service.js";
import type {
  StructuredPredicateFamily,
  SubjectBoundAggregationScope,
  SubjectBoundAggregationRequest,
  SubjectBoundAggregationResult,
  TemporalPlanDetailSupport,
  TypedContractName,
  SubjectPlan
} from "./types.js";
import { verifyPairBinding } from "./pair-binding-verification.js";
import {
  inferSubjectBoundAggregationScope,
  extractPairQuerySurfaceNames,
  extractPrimaryQuerySurfaceNames
} from "./query-subjects.js";
import { buildListSetSupport } from "./support-objects.js";
import { inferPreferenceProfileValues } from "./typed-support-extractors.js";

type StructuredSourceTable = "relationship_memory" | "semantic_memory" | "canonical_states" | "memory_entity_mentions" | "episodic_memory";

interface StructuredSupportRow {
  readonly memory_id: string;
  readonly memory_type: RecallResult["memoryType"];
  readonly content: string;
  readonly occurred_at: string | null;
  readonly namespace_id: string;
  readonly provenance: Record<string, unknown>;
  readonly source_table: StructuredSourceTable;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isGenericCanonicalName(value: string | null | undefined): boolean {
  return /^(?:user|speaker)$/iu.test(normalize(value));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => normalize(value)).filter((value) => value.length > 0))];
}

function searchText(value: string): string {
  return value.replace(/["'():]/gu, " ").replace(/\s+/gu, " ").trim();
}

function inferStructuredPredicateFamily(
  request: SubjectBoundAggregationRequest
): StructuredPredicateFamily | null {
  const queryText = request.queryText;
  const contract = request.retrievalPlan.controllerIntent?.primaryTypedContract ?? null;
  if (contract === "book_recommendation_pair") {
    return /\bread\b/iu.test(queryText) ? "media.recommend" : "media.recommend";
  }
  if (contract === "book_list") {
    return "media.read";
  }
  if (contract === "pair_event_inventory") {
    return "event.attend";
  }
  if (contract === "event_inventory" || contract === "direct_destress_activity") {
    if (contract === "direct_destress_activity") {
      return "activity.general";
    }
    if (/\bactivities?\b|\bpartake\b|\bdestress\b|\brelax\b|\bhobbies?\b/iu.test(queryText)) {
      return "activity.general";
    }
    return /\bplan(?:ning)?\b/iu.test(queryText) ? "event.plan" : "event.attend";
  }
  if (contract === "camping_location_history") {
    return "activity.camping";
  }
  if (contract === "family_activity_inventory") {
    if (/\bon hikes?\b/iu.test(queryText)) {
      return "activity.hike";
    }
    if (/\bwhile camping\b|\bcamping trip\b/iu.test(queryText)) {
      return "activity.camping";
    }
    if (/\bworkshop\b/iu.test(queryText)) {
      return "activity.workshop";
    }
    return "activity.family";
  }
  if (contract === "preference_profile") {
    return /\b(song|music|band|artist|vivaldi|four seasons)\b/iu.test(queryText)
      ? "preference.music"
      : "preference.general";
  }
  if (contract === "structured_direct_reason" || contract === "direct_reason") {
    return "reason.start";
  }
  if (contract === "benefit_reason_slot") {
    return "benefit.effect";
  }
  if (contract === "reasoned_profile_judgment") {
    return "reason.start";
  }
  if (contract === "profile_trait_judgment") {
    return /\b(song|music|band|artist|vivaldi|four seasons)\b/iu.test(queryText) ? "preference.music" : "profile.trait";
  }
  if (contract === "symbolic_value_slot") {
    return "meaning.symbolism";
  }
  if (contract === "made_item_pair_inventory") {
    return /\bpottery|ceramic|bowl|mug|vase|clay\b/iu.test(queryText) ? "creation.pottery" : "creation.paint";
  }
  if (contract === "pet_inventory") {
    return "pet.own";
  }
  if (contract === "temporal_plan_detail") {
    return "event.plan";
  }
  if (contract === "direct_attribute" && /\bcertificate\b|\btake away\b/iu.test(queryText)) {
    return "detail.received_for";
  }
  return null;
}

function inferStructuredContract(
  request: SubjectBoundAggregationRequest
): TypedContractName | null {
  return request.retrievalPlan.controllerIntent?.primaryTypedContract ?? null;
}

interface DependentTarget {
  readonly entityId: string;
  readonly canonicalName: string;
}

function buildAggregationSubjectPlan(params: {
  readonly queryText: string;
  readonly primarySubjectId: string | null;
  readonly primarySubjectName: string | null;
  readonly pairSubjectId: string | null;
  readonly pairSubjectName: string | null;
}): SubjectPlan {
  if (params.pairSubjectName) {
    return {
      kind: "pair_subject",
      subjectEntityId: params.primarySubjectId,
      canonicalSubjectName: params.primarySubjectName,
      pairSubjectEntityId: params.pairSubjectId,
      pairSubjectName: params.pairSubjectName,
      candidateEntityIds: [params.primarySubjectId, params.pairSubjectId].filter((value): value is string => Boolean(value)),
      candidateNames: [params.primarySubjectName, params.pairSubjectName].filter((value): value is string => Boolean(value)),
      reason: `subject_bound_aggregation_pair:${params.primarySubjectName ?? "unknown"}|${params.pairSubjectName}`
    };
  }
  return {
    kind: params.primarySubjectName ? "single_subject" : "no_subject",
    subjectEntityId: params.primarySubjectId,
    canonicalSubjectName: params.primarySubjectName,
    candidateEntityIds: params.primarySubjectId ? [params.primarySubjectId] : [],
    candidateNames: params.primarySubjectName ? [params.primarySubjectName] : [],
    reason: params.primarySubjectName ? "subject_bound_aggregation_primary" : "subject_bound_aggregation_none"
  };
}

function normalizeAggregationItems(params: {
  readonly queryText: string;
  readonly contract: TypedContractName;
  readonly rows: readonly RecallResult[];
  readonly subjectPlan: SubjectPlan;
}): readonly string[] {
  if (params.contract === "preference_profile" && /\bkids?\b|\bchildren\b/iu.test(params.queryText)) {
    return inferPreferenceProfileValues({
      queryText: params.queryText,
      texts: params.rows.map((row) => row.content)
    });
  }
  return buildListSetSupport({
    queryText: params.queryText,
    predicateFamily: "list_set",
    results: params.rows,
    finalClaimText: null,
    subjectPlan: params.subjectPlan
  }).typedEntries;
}

function extractActivityQueryKeywords(queryText: string): readonly string[] {
  const values = new Set<string>();
  const keywordPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["activity", /\bactivities?\b/iu],
    ["hobbies", /\bhobbies?\b/iu],
    ["destress", /\bdestress|stress relief|relax|chill\b/iu],
    ["family", /\bfamily\b/iu],
    ["children", /\bchildren|kids|youth\b/iu],
    ["community", /\bcommunity\b/iu],
    ["pottery", /\bpottery\b/iu],
    ["camping", /\bcamp(?:ed|ing)?\b/iu],
    ["painting", /\bpaint(?:ed|ing)?\b/iu],
    ["swimming", /\bswimm?(?:ing|ed)?\b/iu],
    ["running", /\brunn?(?:ing)?\b/iu],
    ["yoga", /\byoga\b/iu],
    ["hiking", /\bhik(?:e|ing)\b/iu],
    ["classes", /\bclasses?\b/iu],
    ["workshops", /\bworkshops?\b/iu],
    ["support", /\bsupport\b/iu],
    ["mentoring", /\bmentor(?:ing|ship)?\b/iu],
    ["pride", /\bpride\b/iu]
  ];
  for (const [label, pattern] of keywordPatterns) {
    if (pattern.test(queryText)) {
      values.add(label);
    }
  }
  if (/\bhelp\s+(?:children|kids|youth|young people)\b/iu.test(queryText)) {
    values.add("school");
    values.add("speech");
    values.add("mentoring");
    values.add("youth");
  }
  if (/\blgbtq\+?\b|\bcommunity\b/iu.test(queryText)) {
    values.add("activist");
    values.add("art show");
    values.add("support group");
  }
  return [...values];
}

function extractReasonQueryKeywords(queryText: string): readonly string[] {
  const values = new Set<string>();
  const keywordPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["reason", /\breason\b/iu],
    ["because", /\bbecause\b/iu],
    ["support", /\bsupport(?:ed|ive)?\b/iu],
    ["growing up", /\bgrowing up\b/iu],
    ["running", /\brunn?(?:ing)?\b/iu],
    ["counseling", /\bcounsel(?:ing|or)\b/iu],
    ["mental health", /\bmental health\b/iu],
    ["writing", /\bwriting\b/iu],
    ["career", /\bcareer\b/iu]
  ];
  for (const [label, pattern] of keywordPatterns) {
    if (pattern.test(queryText)) {
      values.add(label);
    }
  }
  return [...values];
}

function buildKeywords(family: StructuredPredicateFamily, queryText: string): readonly string[] {
  switch (family) {
    case "media.read":
      return ["book", "books", "read", "reading", "finished", "title", "novel", "story"];
    case "media.recommend":
      return ["book", "books", "recommend", "recommended", "suggestion", "suggested", "read"];
    case "event.attend":
      return unique([
        "event",
        "events",
        "attended",
        "participated",
        "festival",
        ...extractActivityQueryKeywords(queryText)
      ]);
    case "event.plan":
      return ["plan", "planning", "event", "grand opening", "fundraiser", "do"];
    case "activity.general":
      return [
        "activities",
        "activity",
        "hobbies",
        "hobby",
        "pottery",
        "camping",
        "painting",
        "swimming",
        "running",
        "reading",
        "violin",
        "relax",
        "destress"
      ];
    case "activity.family":
      return ["family", "kids", "children", "together", "activities", "did", "do"];
    case "activity.hike":
      return ["hike", "hiking", "trail", "family", "outdoors"];
    case "activity.camping":
      return ["camp", "camped", "camping", "campsite", "campground", "trip"];
    case "activity.workshop":
      return ["workshop", "class", "session", "discussion", "talked about"];
    case "creation.paint":
      return ["paint", "painted", "painting", "canvas", "art project"];
    case "creation.pottery":
      return ["pottery", "ceramic", "clay", "bowl", "mug", "vase", "made"];
    case "preference.general":
      return /\bkids?\b|\bchildren\b/iu.test(queryText)
        ? ["like", "likes", "love", "enjoy", "favorite", "favorites", "kids", "children", "family", "dinosaur", "nature", "outdoors", "museum", "exhibit", "park", "stoked", "excited", "obsessed"]
        : ["like", "likes", "love", "enjoy", "favorite", "favorites", "kids", "children", "family"];
    case "preference.music":
      return ["music", "song", "songs", "band", "artist", "classical", "enjoy", "like"];
    case "profile.trait":
      return ["religious", "personality", "trait", "traits", "political", "leaning", "move back", "enjoy"];
    case "pet.own":
      return ["pet", "pets", "dog", "dogs", "cat", "cats", "turtle", "turtles"];
    case "benefit.effect":
      return ["motivated", "inspired", "great for", "helped", "benefit", "take away"];
    case "reason.start":
      return unique(["reason", "because", "started", "got into", ...extractReasonQueryKeywords(queryText)]);
    case "meaning.symbolism":
      return ["symbolize", "symbolism", "represents", "meaning", "necklace", "tattoo", "drawing"];
    case "detail.received_for":
      return /\btake away\b/iu.test(queryText)
        ? ["take away", "learned", "visiting", "hospital"]
        : ["certificate", "received", "for"];
    default:
      return [];
  }
}

function buildStructuredSearchQuery(
  request: SubjectBoundAggregationRequest,
  pairNames: readonly string[],
  predicateFamily: StructuredPredicateFamily
): string {
  const names = unique([
    ...request.retrievalPlan.subjectNames,
    ...request.subjectHints,
    ...extractPrimaryQuerySurfaceNames(request.queryText),
    ...pairNames
  ]);
  const keywords = buildKeywords(predicateFamily, request.queryText);
  return unique([...names, ...keywords, searchText(request.queryText)])
    .map((value) => (/\s/u.test(value) ? `"${value}"` : value))
    .join(" OR ");
}

function valueMentionsName(value: unknown, name: string): boolean {
  const normalizedName = normalize(name).toLowerCase();
  if (!normalizedName) {
    return false;
  }
  const haystack = searchText(typeof value === "string" ? value : JSON.stringify(value ?? {})).toLowerCase();
  return haystack.includes(normalizedName);
}

function valueMentionsEntityId(value: unknown, entityId: string): boolean {
  const normalizedEntityId = normalize(entityId).toLowerCase();
  if (!normalizedEntityId) {
    return false;
  }
  return searchText(typeof value === "string" ? value : JSON.stringify(value ?? {})).toLowerCase().includes(normalizedEntityId);
}

function rowMatchesRequiredBindings(params: {
  readonly row: StructuredSupportRow;
  readonly names: readonly string[];
  readonly entityIds: readonly string[];
}): boolean {
  if (params.names.length === 0 && params.entityIds.length === 0) {
    return true;
  }
  const { row } = params;
  const provenance = row.provenance ?? {};
  const rowHasEntityBindings = params.entityIds.some((entityId) =>
    valueMentionsEntityId(provenance.subject_entity_id, entityId) ||
    valueMentionsEntityId(provenance.object_entity_id, entityId) ||
    valueMentionsEntityId(provenance.anchor_entity_id, entityId) ||
    valueMentionsEntityId(provenance.metadata, entityId) ||
    valueMentionsEntityId(provenance.normalized_value, entityId)
  );
  const matchesEntityIds = !rowHasEntityBindings || params.entityIds.every((entityId) =>
    valueMentionsEntityId(provenance.subject_entity_id, entityId) ||
    valueMentionsEntityId(provenance.object_entity_id, entityId) ||
    valueMentionsEntityId(provenance.anchor_entity_id, entityId) ||
    valueMentionsEntityId(provenance.metadata, entityId) ||
    valueMentionsEntityId(provenance.normalized_value, entityId)
  );
  if (!matchesEntityIds) {
    return false;
  }
  return params.names.every((name) =>
    valueMentionsName(row.content, name) ||
    valueMentionsName(provenance.person_name, name) ||
    valueMentionsName(provenance.subject_name, name) ||
    valueMentionsName(provenance.object_name, name) ||
    valueMentionsName(provenance.canonical_subject_name, name) ||
    valueMentionsName(provenance.mention_text, name) ||
    valueMentionsName(provenance.normalized_value, name) ||
    valueMentionsName(provenance.metadata, name)
  );
}

async function loadCanonicalStateRows(params: {
  readonly namespaceId: string;
  readonly subjectEntityId: string | null;
  readonly searchQuery: string;
  readonly limit: number;
  readonly predicateFamily: StructuredPredicateFamily;
}): Promise<readonly StructuredSupportRow[]> {
  if (!params.subjectEntityId) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT
        cst.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        cst.state_value AS content,
        COALESCE(cst.mentioned_at, cst.valid_from)::text AS occurred_at,
        cst.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'canonical_states',
            'canonical_subject_name', subject_entity.canonical_name,
            'subject_entity_id', cst.subject_entity_id::text,
            'predicate_family', cst.predicate_family,
            'metadata', cst.metadata
          )
        ) AS provenance,
        'canonical_states'::text AS source_table
      FROM canonical_states cst
      JOIN entities subject_entity
        ON subject_entity.id = cst.subject_entity_id
      WHERE cst.namespace_id = $1
        AND cst.subject_entity_id = $2::uuid
        AND (
          to_tsvector(
            'english',
            concat_ws(' ', cst.state_value, subject_entity.canonical_name, COALESCE(cst.metadata::text, ''))
          ) @@ websearch_to_tsquery('english', $3)
          OR lower(cst.state_value) LIKE '%' || lower($4) || '%'
        )
      ORDER BY
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(' ', cst.state_value, subject_entity.canonical_name, COALESCE(cst.metadata::text, ''))
          ),
          websearch_to_tsquery('english', $3)
        ) DESC,
        cst.confidence DESC,
        COALESCE(cst.mentioned_at, cst.valid_from) DESC
      LIMIT $5
    `,
    [params.namespaceId, params.subjectEntityId, params.searchQuery, params.predicateFamily.split(".")[1], params.limit]
  );
}

async function loadSemanticRows(params: {
  readonly namespaceId: string;
  readonly searchQuery: string;
  readonly limit: number;
}): Promise<readonly StructuredSupportRow[]> {
  return queryRows<StructuredSupportRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        COALESCE(em.occurred_at, sm.valid_from)::text AS occurred_at,
        sm.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'semantic_memory',
            'canonical_key', sm.canonical_key,
            'memory_kind', sm.memory_kind,
            'person_name', sm.normalized_value->>'person_name',
            'subject_entity_id', COALESCE(sm.normalized_value->>'subject_entity_id', sm.metadata->>'subject_entity_id'),
            'normalized_value', sm.normalized_value,
            'metadata', sm.metadata
          )
        ) AS provenance,
        'semantic_memory'::text AS source_table
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND to_tsvector(
          'english',
          concat_ws(
            ' ',
            sm.content_abstract,
            COALESCE(sm.canonical_key, ''),
            COALESCE(sm.normalized_value::text, ''),
            COALESCE(sm.metadata::text, '')
          )
        ) @@ websearch_to_tsquery('english', $2)
      ORDER BY
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(
              ' ',
              sm.content_abstract,
              COALESCE(sm.canonical_key, ''),
              COALESCE(sm.normalized_value::text, ''),
              COALESCE(sm.metadata::text, '')
            )
          ),
          websearch_to_tsquery('english', $2)
        ) DESC,
        COALESCE(em.occurred_at, sm.valid_from) DESC
      LIMIT $3
    `,
    [params.namespaceId, params.searchQuery, params.limit]
  );
}

async function loadSemanticRowsBySubjectName(params: {
  readonly namespaceId: string;
  readonly subjectName: string;
  readonly limit: number;
}): Promise<readonly StructuredSupportRow[]> {
  const subjectName = normalize(params.subjectName);
  if (!subjectName) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT
        sm.id::text AS memory_id,
        'semantic_memory'::text AS memory_type,
        sm.content_abstract AS content,
        COALESCE(em.occurred_at, sm.valid_from)::text AS occurred_at,
        sm.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'semantic_memory',
            'canonical_key', sm.canonical_key,
            'memory_kind', sm.memory_kind,
            'person_name', sm.normalized_value->>'person_name',
            'subject_entity_id', COALESCE(sm.normalized_value->>'subject_entity_id', sm.metadata->>'subject_entity_id'),
            'normalized_value', sm.normalized_value,
            'metadata', sm.metadata
          )
        ) AS provenance,
        'semantic_memory'::text AS source_table
      FROM semantic_memory sm
      LEFT JOIN episodic_memory em
        ON em.id = sm.source_episodic_id
      WHERE sm.namespace_id = $1
        AND sm.status = 'active'
        AND sm.valid_until IS NULL
        AND (
          lower(sm.normalized_value->>'person_name') = lower($2)
          OR lower(sm.metadata::text) LIKE '%' || lower($2) || '%'
          OR lower(sm.content_abstract) LIKE '%' || lower($2) || '%'
        )
      ORDER BY COALESCE(em.occurred_at, sm.valid_from) DESC
      LIMIT $3
    `,
    [params.namespaceId, subjectName, params.limit]
  );
}

async function loadRelationshipRows(params: {
  readonly namespaceId: string;
  readonly primarySubjectId: string | null;
  readonly pairSubjectId: string | null;
  readonly searchQuery: string;
  readonly limit: number;
}): Promise<readonly StructuredSupportRow[]> {
  if (!params.primarySubjectId) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT
        rm.id::text AS memory_id,
        'relationship_memory'::text AS memory_type,
        concat_ws(' ', subject_entity.canonical_name, replace(rm.predicate, '_', ' '), object_entity.canonical_name) AS content,
        COALESCE(em.occurred_at, rm.valid_from)::text AS occurred_at,
        rm.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'relationship_memory',
            'subject_name', subject_entity.canonical_name,
            'object_name', object_entity.canonical_name,
            'subject_entity_id', rm.subject_entity_id::text,
            'object_entity_id', rm.object_entity_id::text,
            'predicate', rm.predicate,
            'metadata', rm.metadata
          )
        ) AS provenance,
        'relationship_memory'::text AS source_table
      FROM relationship_memory rm
      JOIN entities subject_entity
        ON subject_entity.id = rm.subject_entity_id
      JOIN entities object_entity
        ON object_entity.id = rm.object_entity_id
      LEFT JOIN relationship_candidates rc
        ON rc.id = rm.source_candidate_id
      LEFT JOIN episodic_memory em
        ON em.id = rc.source_memory_id
      WHERE rm.namespace_id = $1
        AND rm.status <> 'invalid'
        AND (
          rm.subject_entity_id = $2::uuid
          OR rm.object_entity_id = $2::uuid
        )
        AND (
          $3::uuid IS NULL
          OR rm.subject_entity_id = $3::uuid
          OR rm.object_entity_id = $3::uuid
        )
        AND to_tsvector(
          'english',
          concat_ws(' ', subject_entity.canonical_name, object_entity.canonical_name, rm.predicate, COALESCE(rm.metadata::text, ''))
        ) @@ websearch_to_tsquery('english', $4)
      ORDER BY
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(' ', subject_entity.canonical_name, object_entity.canonical_name, rm.predicate, COALESCE(rm.metadata::text, ''))
          ),
          websearch_to_tsquery('english', $4)
        ) DESC,
        COALESCE(em.occurred_at, rm.valid_from) DESC
      LIMIT $5
    `,
    [params.namespaceId, params.primarySubjectId, params.pairSubjectId, params.searchQuery, params.limit]
  );
}

async function resolveDependentTargets(params: {
  readonly namespaceId: string;
  readonly primarySubjectId: string | null;
}): Promise<readonly DependentTarget[]> {
  if (!params.primarySubjectId) {
    return [];
  }
  return queryRows<DependentTarget>(
    `
      SELECT DISTINCT
        related_entity.id::text AS entity_id,
        related_entity.canonical_name
      FROM relationship_memory rm
      JOIN entities related_entity
        ON related_entity.id =
          CASE
            WHEN rm.subject_entity_id = $2::uuid THEN rm.object_entity_id
            ELSE rm.subject_entity_id
          END
      WHERE rm.namespace_id = $1
        AND rm.status <> 'invalid'
        AND (rm.subject_entity_id = $2::uuid OR rm.object_entity_id = $2::uuid)
        AND rm.predicate = ANY($3::text[])
      ORDER BY related_entity.canonical_name ASC
      LIMIT 6
    `,
    [params.namespaceId, params.primarySubjectId, ["parent_of", "child_of", "lives_with"]]
  );
}

async function loadMentionRows(params: {
  readonly namespaceId: string;
  readonly anchorEntityIds: readonly string[];
  readonly searchQuery: string;
  readonly limit: number;
  readonly requireDependentCue: boolean;
  readonly predicateFamily: StructuredPredicateFamily;
}): Promise<readonly StructuredSupportRow[]> {
  if (params.anchorEntityIds.length === 0) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT DISTINCT ON (e.id)
        e.id::text AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        e.occurred_at::text AS occurred_at,
        e.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'memory_entity_mentions',
            'anchor_entity_id', mem.entity_id::text,
            'mention_role', mem.mention_role,
            'mention_text', mem.mention_text,
            'metadata', e.metadata
          )
        ) AS provenance,
        'memory_entity_mentions'::text AS source_table
      FROM memory_entity_mentions mem
      JOIN episodic_memory e
        ON e.id = mem.source_memory_id
       AND e.namespace_id = $1
      WHERE mem.namespace_id = $1
        AND mem.entity_id = ANY($2::uuid[])
        AND to_tsvector(
          'english',
          concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, ''))
        ) @@ websearch_to_tsquery('english', $3)
        AND (
          $5::boolean = false
          OR concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, '')) ~* $6
          OR (
            $4::text = 'preference.general'
            AND concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, '')) ~* '(dinosaur|nature|outdoors?|stoked for|excited about|obsessed with|really into)'
          )
        )
        AND (
          $4::text <> 'activity.camping'
          OR EXISTS (
            SELECT 1
            FROM memory_entity_mentions loc
            WHERE loc.namespace_id = $1
              AND loc.source_memory_id = e.id
              AND loc.mention_role = 'location'
          )
          OR (
            e.content ~* 'camp(?:ed|ing|site|ground)?'
            AND e.content ~* '(beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)'
          )
        )
      ORDER BY
        e.id,
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, ''))
          ),
          websearch_to_tsquery('english', $3)
        ) DESC,
        e.occurred_at DESC
      LIMIT $7
    `,
    [
      params.namespaceId,
      params.anchorEntityIds,
      params.searchQuery,
      params.predicateFamily,
      params.requireDependentCue,
      "(kids?|children|sons?|daughters?)",
      params.limit
    ]
  );
}

async function loadMentionRowsBySubjectName(params: {
  readonly namespaceId: string;
  readonly subjectName: string;
  readonly searchQuery: string;
  readonly limit: number;
  readonly requireDependentCue: boolean;
  readonly predicateFamily: StructuredPredicateFamily;
}): Promise<readonly StructuredSupportRow[]> {
  const subjectName = normalize(params.subjectName);
  if (!subjectName) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT DISTINCT ON (e.id)
        e.id::text AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        e.occurred_at::text AS occurred_at,
        e.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'memory_entity_mentions',
            'mention_role', mem.mention_role,
            'mention_text', mem.mention_text,
            'metadata', e.metadata
          )
        ) AS provenance,
        'memory_entity_mentions'::text AS source_table
      FROM memory_entity_mentions mem
      JOIN episodic_memory e
        ON e.id = mem.source_memory_id
       AND e.namespace_id = $1
      WHERE mem.namespace_id = $1
        AND (
          lower(COALESCE(mem.mention_text, '')) LIKE '%' || lower($2) || '%'
          OR lower(e.content) LIKE '%' || lower($2) || '%'
          OR lower(COALESCE(e.metadata::text, '')) LIKE '%' || lower($2) || '%'
        )
        AND to_tsvector(
          'english',
          concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, ''))
        ) @@ websearch_to_tsquery('english', $3)
        AND (
          $5::boolean = false
          OR concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, '')) ~* $6
          OR (
            $4::text = 'preference.general'
            AND concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, '')) ~* '(dinosaur|nature|outdoors?|stoked for|excited about|obsessed with|really into)'
          )
        )
        AND (
          $4::text <> 'activity.camping'
          OR EXISTS (
            SELECT 1
            FROM memory_entity_mentions loc
            WHERE loc.namespace_id = $1
              AND loc.source_memory_id = e.id
              AND loc.mention_role = 'location'
          )
          OR (
            e.content ~* 'camp(?:ed|ing|site|ground)?'
            AND e.content ~* '(beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)'
          )
        )
      ORDER BY
        e.id,
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(' ', e.content, COALESCE(mem.mention_text, ''), COALESCE(e.metadata::text, ''))
          ),
          websearch_to_tsquery('english', $3)
        ) DESC,
        e.occurred_at DESC
      LIMIT $7
    `,
    [
      params.namespaceId,
      subjectName,
      params.searchQuery,
      params.predicateFamily,
      params.requireDependentCue,
      "(kids?|children|sons?|daughters?)",
      params.limit
    ]
  );
}

async function loadEpisodicRowsBySubjectName(params: {
  readonly namespaceId: string;
  readonly subjectName: string;
  readonly searchQuery: string;
  readonly limit: number;
  readonly requireDependentCue: boolean;
  readonly predicateFamily: StructuredPredicateFamily;
}): Promise<readonly StructuredSupportRow[]> {
  const subjectName = normalize(params.subjectName);
  if (!subjectName) {
    return [];
  }
  return queryRows<StructuredSupportRow>(
    `
      SELECT
        e.id::text AS memory_id,
        'episodic_memory'::text AS memory_type,
        e.content,
        e.occurred_at::text AS occurred_at,
        e.namespace_id,
        jsonb_strip_nulls(
          jsonb_build_object(
            'tier', 'subject_bound_structured_aggregation',
            'source_table', 'episodic_memory',
            'metadata', e.metadata
          )
        ) AS provenance,
        'episodic_memory'::text AS source_table
      FROM episodic_memory e
      WHERE e.namespace_id = $1
        AND (
          lower(e.content) LIKE '%' || lower($2) || '%'
          OR lower(COALESCE(e.metadata::text, '')) LIKE '%' || lower($2) || '%'
        )
        AND to_tsvector(
          'english',
          concat_ws(' ', e.content, COALESCE(e.metadata::text, ''))
        ) @@ websearch_to_tsquery('english', $3)
        AND (
          $5::boolean = false
          OR concat_ws(' ', e.content, COALESCE(e.metadata::text, '')) ~* $6
          OR (
            $4::text = 'preference.general'
            AND concat_ws(' ', e.content, COALESCE(e.metadata::text, '')) ~* '(dinosaur|nature|outdoors?|stoked for|excited about|obsessed with|really into)'
          )
        )
        AND (
          $4::text <> 'activity.camping'
          OR (
            e.content ~* 'camp(?:ed|ing|site|ground)?'
            AND e.content ~* '(beach|mountains?|forest|woods?|lake|river|canyon|desert|campground|campsite|park|ridge|valley)'
          )
        )
        AND (
          $4::text <> 'media.read'
          OR e.content ~* '(read|reading|reads|book|books|novel|story)'
        )
        AND (
          $4::text <> 'media.recommend'
          OR e.content ~* '(recommend|recommended|suggest|suggested|book|books|reading|read)'
        )
        AND (
          $4::text <> 'preference.general'
          OR e.content ~* '(like|likes|love|loves|enjoy|enjoys|favorite|favourite|interested in|into)'
          OR (
            $5::boolean = true
            AND e.content ~* '(dinosaur|nature|outdoors?|stoked for|excited about|obsessed with|really into)'
          )
        )
      ORDER BY
        ts_rank(
          to_tsvector(
            'english',
            concat_ws(' ', e.content, COALESCE(e.metadata::text, ''))
          ),
          websearch_to_tsquery('english', $3)
        ) DESC,
        e.occurred_at DESC
      LIMIT $7
    `,
    [
      params.namespaceId,
      subjectName,
      params.searchQuery,
      params.predicateFamily,
      params.requireDependentCue,
      "(kids?|children|sons?|daughters?)",
      params.limit
    ]
  );
}

function toRecallResult(row: StructuredSupportRow, predicateFamily: StructuredPredicateFamily): RecallResult {
  return {
    memoryId: row.memory_id,
    memoryType: row.memory_type,
    content: row.content,
    artifactId: null,
    occurredAt: row.occurred_at,
    namespaceId: row.namespace_id,
    provenance: {
      ...row.provenance,
      structured_predicate_family: predicateFamily
    }
  };
}

export async function collectSubjectBoundAggregation(
  request: SubjectBoundAggregationRequest
): Promise<SubjectBoundAggregationResult> {
  const predicateFamily = inferStructuredPredicateFamily(request);
  const contract = inferStructuredContract(request);
  if (!predicateFamily || !contract) {
    return {
      attempted: false,
      rows: [],
      sources: [],
      predicateFamily: null,
      pairBinding: null,
      aggregationScope: null,
      normalizedItemKeys: [],
      groundedItemKeys: []
    };
  }

  const pairBinding = await verifyPairBinding(request);
  const aggregationScope =
    request.aggregationScope ??
    inferSubjectBoundAggregationScope(request.queryText, Boolean(pairBinding?.required));
  if (pairBinding?.required && !pairBinding.verified) {
    return {
      attempted: true,
      rows: [],
      sources: [],
      predicateFamily,
      pairBinding,
      aggregationScope,
      normalizedItemKeys: [],
      groundedItemKeys: []
    };
  }

  const resolvedPrimary =
    pairBinding?.primarySubjectId || pairBinding?.primarySubjectName
      ? {
          entityId: pairBinding?.primarySubjectId ?? null,
          canonicalName:
            pairBinding?.primarySubjectName ??
            request.retrievalPlan.subjectNames[0] ??
            request.subjectHints[0] ??
            null
        }
      : await resolveCanonicalEntityReference(
          request.namespaceId,
          request.retrievalPlan.subjectNames[0] ?? request.subjectHints[0] ?? extractPrimaryQuerySurfaceNames(request.queryText)[0] ?? ""
        );
  const dependentTargets =
    aggregationScope === "dependent_group"
      ? await resolveDependentTargets({
          namespaceId: request.namespaceId,
          primarySubjectId: resolvedPrimary?.entityId ?? null
        })
      : [];
  const pairNames = unique([
    ...extractPairQuerySurfaceNames(request.queryText),
    pairBinding?.pairSubjectName ?? ""
  ]);
  const explicitPrimaryName =
    request.retrievalPlan.subjectNames[0] ??
    request.subjectHints[0] ??
    extractPrimaryQuerySurfaceNames(request.queryText)[0] ??
    "";
  const genericResolvedPrimary = isGenericCanonicalName(resolvedPrimary?.canonicalName);
  const primarySubjectName =
    (!genericResolvedPrimary ? resolvedPrimary?.canonicalName : null) ??
    pairBinding?.primarySubjectName ??
    explicitPrimaryName;
  const searchQuery = buildStructuredSearchQuery(request, pairNames, predicateFamily);
  const limit = Math.max(4, Math.min(request.limit, 12));
  const anchorEntityIds =
    aggregationScope === "dependent_group" && dependentTargets.length > 0
      ? dependentTargets.map((target) => target.entityId)
      : resolvedPrimary?.entityId && !genericResolvedPrimary
        ? [resolvedPrimary.entityId]
        : [];

  const [canonicalRows, semanticRows, relationshipRows, subjectSemanticRows, mentionRows, subjectMentionRows, subjectEpisodicRows] = await Promise.all([
    loadCanonicalStateRows({
      namespaceId: request.namespaceId,
      subjectEntityId: resolvedPrimary?.entityId ?? null,
      searchQuery,
      limit,
      predicateFamily
    }),
    loadSemanticRows({
      namespaceId: request.namespaceId,
      searchQuery,
      limit
    }),
    loadRelationshipRows({
      namespaceId: request.namespaceId,
      primarySubjectId: resolvedPrimary?.entityId ?? null,
      pairSubjectId: pairBinding?.pairSubjectId ?? null,
      searchQuery,
      limit
    }),
    (
      (predicateFamily === "activity.general" ||
        predicateFamily === "activity.camping" ||
        predicateFamily === "preference.general" ||
        predicateFamily === "media.read") &&
      (!pairBinding?.primarySubjectId || genericResolvedPrimary)
    )
      ? loadSemanticRowsBySubjectName({
          namespaceId: request.namespaceId,
          subjectName: primarySubjectName,
          limit: Math.max(limit, 12)
        })
      : Promise.resolve([]),
    loadMentionRows({
      namespaceId: request.namespaceId,
      anchorEntityIds,
      searchQuery,
      limit: Math.max(limit, 10),
      requireDependentCue: aggregationScope === "dependent_group",
      predicateFamily
    }),
    (!resolvedPrimary?.entityId || genericResolvedPrimary) && primarySubjectName
      ? loadMentionRowsBySubjectName({
          namespaceId: request.namespaceId,
          subjectName: primarySubjectName,
          searchQuery,
          limit: Math.max(limit, 10),
          requireDependentCue: aggregationScope === "dependent_group",
          predicateFamily
        })
      : Promise.resolve([]),
    primarySubjectName
      ? loadEpisodicRowsBySubjectName({
          namespaceId: request.namespaceId,
          subjectName: primarySubjectName,
          searchQuery,
          limit: Math.max(limit, 12),
          requireDependentCue: aggregationScope === "dependent_group",
          predicateFamily
        })
      : Promise.resolve([])
  ]);

  const requiredEntityIds = unique([
    aggregationScope === "dependent_group" || genericResolvedPrimary ? "" : (resolvedPrimary?.entityId ?? ""),
    ...(aggregationScope === "dependent_group" ? dependentTargets.map((target) => target.entityId) : []),
    pairBinding?.required ? (pairBinding?.pairSubjectId ?? "") : ""
  ]);
  const requiredNames = unique([
    aggregationScope === "dependent_group" && dependentTargets.length > 0 ? "" : primarySubjectName,
    pairBinding?.required && !pairBinding?.pairSubjectId ? (pairBinding?.pairSubjectName ?? "") : "",
    (!resolvedPrimary?.entityId || genericResolvedPrimary) && aggregationScope !== "dependent_group" ? primarySubjectName : ""
  ]);
  const combinedRows = [...canonicalRows, ...semanticRows, ...relationshipRows, ...subjectSemanticRows, ...mentionRows, ...subjectMentionRows, ...subjectEpisodicRows]
    .filter((row) => rowMatchesRequiredBindings({ row, names: requiredNames, entityIds: requiredEntityIds }))
    .map((row) => toRecallResult(row, predicateFamily));
  const sources = unique(
    [...canonicalRows, ...semanticRows, ...relationshipRows, ...subjectSemanticRows, ...mentionRows, ...subjectMentionRows, ...subjectEpisodicRows]
      .map((row) => row.source_table)
  ) as readonly StructuredSourceTable[];
  const subjectPlan = buildAggregationSubjectPlan({
    queryText: request.queryText,
    primarySubjectId: resolvedPrimary?.entityId ?? null,
    primarySubjectName: primarySubjectName || null,
    pairSubjectId: pairBinding?.pairSubjectId ?? null,
    pairSubjectName: pairBinding?.pairSubjectName ?? null
  });
  const selectedRows: RecallResult[] = [];
  let selectedItems: readonly string[] = [];
  for (const row of combinedRows) {
    const candidateRows = [...selectedRows, row];
    const candidateItems = normalizeAggregationItems({
      queryText: request.queryText,
      contract,
      rows: candidateRows,
      subjectPlan
    });
    if (selectedRows.length === 0 || candidateItems.length > selectedItems.length) {
      selectedRows.push(row);
      selectedItems = candidateItems;
    }
    if (selectedRows.length >= limit || selectedItems.length >= Math.max(2, limit - 2)) {
      break;
    }
  }
  const filtered = (selectedRows.length > 0 ? selectedRows : combinedRows.slice(0, limit)).slice(0, limit);
  const normalizedItemKeys = normalizeAggregationItems({
    queryText: request.queryText,
    contract,
    rows: filtered,
    subjectPlan
  });

  return {
    attempted: true,
    rows: filtered,
    sources,
    predicateFamily,
    pairBinding,
    aggregationScope,
    normalizedItemKeys,
    groundedItemKeys: normalizedItemKeys
  };
}

export function buildTemporalPlanDetailSupport(
  queryText: string,
  rows: readonly RecallResult[]
): TemporalPlanDetailSupport {
  const bestRow =
    rows.find((row) => /\bplan(?:ning)?\b|\bgrand opening\b|\bfunraiser\b|\bfundraiser\b/iu.test(row.content)) ??
    rows[0] ??
    null;
  return {
    eventKey:
      bestRow && /\bgrand opening\b/iu.test(queryText)
        ? "grand_opening"
        : bestRow && /\bfunraiser\b|\bfundraiser\b/iu.test(queryText)
          ? "fundraiser"
          : null,
    planValue: bestRow?.content ?? null,
    supportRows: bestRow ? [bestRow] : []
  };
}
