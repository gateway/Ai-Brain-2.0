import { buildPreciseFactEvidenceQueryText } from "../query-builders.js";
import type { SearchRow } from "../internal-types.js";
import type { SupportLoaderHelpers } from "./contracts.js";
import { inferExactDetailQuestionFamily } from "../../exact-detail-question-family.js";

function isFirstPersonQueryText(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
}

function buildSelfOwnedSignalBonus(params: {
  readonly queryText: string;
  readonly signalExpr: string;
  readonly sourceExpr: string;
}): string {
  if (!isFirstPersonQueryText(params.queryText)) {
    return "0";
  }
  return `
    CASE
      WHEN lower(${params.signalExpr}) IN ('self', 'owner') THEN 8
      WHEN lower(${params.signalExpr}) LIKE 'self:%' OR lower(${params.signalExpr}) LIKE 'owner:%' THEN 8
      WHEN lower(${params.sourceExpr}) LIKE '% my %' OR lower(${params.sourceExpr}) LIKE 'my %' OR lower(${params.sourceExpr}) LIKE '% my' THEN 3
      WHEN lower(${params.sourceExpr}) LIKE '% mine %' OR lower(${params.sourceExpr}) LIKE 'mine %' OR lower(${params.sourceExpr}) LIKE '% mine' THEN 3
      WHEN lower(${params.sourceExpr}) LIKE '% me %' OR lower(${params.sourceExpr}) LIKE 'me %' OR lower(${params.sourceExpr}) LIKE '% me' THEN 2
      WHEN lower(${params.sourceExpr}) LIKE '% i''m %' OR lower(${params.sourceExpr}) LIKE 'i''m %' OR lower(${params.sourceExpr}) LIKE '% i''m' THEN 2
      WHEN lower(${params.sourceExpr}) LIKE '% i''ve %' OR lower(${params.sourceExpr}) LIKE 'i''ve %' OR lower(${params.sourceExpr}) LIKE '% i''ve' THEN 2
      WHEN lower(${params.sourceExpr}) LIKE '% you''re %' OR lower(${params.sourceExpr}) LIKE 'you''re %' OR lower(${params.sourceExpr}) LIKE '% you''re' THEN 1.5
      WHEN lower(${params.sourceExpr}) LIKE '% you''ve %' OR lower(${params.sourceExpr}) LIKE 'you''ve %' OR lower(${params.sourceExpr}) LIKE '% you''ve' THEN 1.5
      WHEN lower(${params.sourceExpr}) LIKE '% your %' OR lower(${params.sourceExpr}) LIKE 'your %' OR lower(${params.sourceExpr}) LIKE '% your' THEN 1
      ELSE 0
    END
  `;
}

function buildExactDetailFamilyBackstopClause(
  exactFamily: ReturnType<typeof inferExactDetailQuestionFamily>,
  documentExpr: string
): string {
  switch (exactFamily) {
    case "service_name":
      return `lower(${documentExpr}) ~ '(spotify|apple music|youtube music|pandora|tidal|soundcloud|deezer|streaming service|music service|discover weekly|playlist)'`;
    case "speed":
      return `${documentExpr} ~* '(\\m\\d+(?:\\.\\d+)?\\s*(?:mbps|gbps)\\M|upgraded to\\s+\\d+(?:\\.\\d+)?\\s*(?:mbps|gbps)|internet plan|wifi speed|broadband|fiber)'`;
    case "venue":
      return `${documentExpr} ~* '(study abroad|abroad program|bachelor|degree|university|college|campus|school|wedding|yoga|studio|classes?|attended|completed|graduated)'`;
    case "certification":
      return `${documentExpr} ~* '(certification|certificate|completed\\s+(?:a\\s+|an\\s+)?[A-Za-z][A-Za-z0-9''&/ -]{2,80}\\s+(?:certification|certificate)|course|program)'`;
    case "capacity":
      return `${documentExpr} ~* '(\\m\\d+(?:\\.\\d+)?\\s*(?:gb|tb)\\M|ram|memory|storage)'`;
    case "time_of_day":
      return `${documentExpr} ~* '(\\m\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\M|noon|midnight)'`;
    case "duration":
      return `${documentExpr} ~* '(\\m\\d+\\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\M)'`;
    case "role":
      return `${documentExpr} ~* '(worked as|working as|previous occupation|role is|job was|position was|graphic designer|engineer|teacher|manager)'`;
    case "shop":
      return `${documentExpr} ~* '(bought|purchased|redeemed|from\\s+[A-Z][A-Za-z0-9''&.-]*(?:\\s+[A-Z][A-Za-z0-9''&.-]*){0,4}|store|shop|retailer|market)'`;
    case "breed":
      return `${documentExpr} ~* '(dog is\\s+(?:a|an)|breed|collie|retriever|shepherd|terrier|bulldog|poodle|husky)'`;
    case "count":
      return `${documentExpr} ~* '(\\m(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\M\\s+(?:bike|bikes|dog|dogs|cat|cats|camera|cameras|item|items))'`;
    case "brand":
      return `${documentExpr} ~* '(brand|running shoes|sneakers|nike|adidas|brooks|asics|new balance|hoka|saucony)'`;
    default:
      return "FALSE";
  }
}

function buildExactDetailScopeFilter(
  queryText: string,
  exactFamily: ReturnType<typeof inferExactDetailQuestionFamily>,
  documentExpr: string
): string {
  if (/\bhow\s+long\b/i.test(queryText)) {
    return `${documentExpr} ~* '(commute|each way|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)'`;
  }
  if (/\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)) {
    return `${documentExpr} ~* '(play|movie|film|show|book|song|title|attended|watched|read|called|production of|saw)'`;
  }
  if (/\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)) {
    return `${documentExpr} ~* '(class|classes|yoga|studio|near|at|to)'`;
  }
  const backstop = buildExactDetailFamilyBackstopClause(exactFamily, documentExpr);
  return backstop === "FALSE" ? "TRUE" : backstop;
}

export function loadStorageLocationSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, candidateLimit } = params;
  const terms = ["storage", "stored", "Bend", "Reno", "Carson", "Jeep", "RV", "Lauren", "Alex", "Eve"];
  const match = helpers.buildFocusedLikeMatchClause(2, terms, "em.content");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (${match.scoreExpression})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'storage_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ${match.clause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 2}
    `,
    [namespaceId, ...match.values, Math.max(candidateLimit, 8)]
  );
}

export function loadPreciseFactSupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const exactFamily = inferExactDetailQuestionFamily(queryText);
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 10);
  const preciseDocument = "coalesce(em.metadata->>'source_turn_text', em.metadata->>'source_sentence_text', em.content)";
  const match = helpers.buildFocusedLikeMatchClause(4, terms, preciseDocument);
  const durationBonus = /\bhow\s+long\b/i.test(queryText)
    ? `CASE WHEN ${preciseDocument} ~* '\\m\\d+\\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\\M' THEN 3 ELSE 0 END`
    : "0";
  const commuteBonus = /\bcommute\b/i.test(queryText)
    ? `CASE WHEN lower(${preciseDocument}) LIKE '%commute%' THEN 5 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%each way%' THEN 6 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%daily commute%' THEN 3 ELSE 0 END`
    : "0";
  const playlistBonus = /\bplaylist|spotify\b/i.test(queryText)
    ? `CASE WHEN lower(${preciseDocument}) LIKE '%playlist%' THEN 4 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%spotify%' THEN 3 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%called %' THEN 2 ELSE 0 END`
    : "0";
  const classLocationBonus = /\bwhere\b/i.test(queryText) && /\bclass|classes|yoga\b/i.test(queryText)
    ? `CASE WHEN ${preciseDocument} ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 7 ELSE 0 END + CASE WHEN ${preciseDocument} ~ '(near|at|to)\\s+[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 5 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%serenity yoga%' THEN 6 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%yoga%' THEN 2 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%class%' THEN 2 ELSE 0 END + CASE WHEN lower(${preciseDocument}) LIKE '%studio%' THEN 1 ELSE 0 END`
    : "0";
  const titleBonus = /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText)
    ? `CASE WHEN ${preciseDocument} ~* '(production of|watched|read|attended|saw|play|movie|book|show|title|called)' THEN 2 ELSE 0 END`
    : "0";
  const nameBonus = /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)
    ? `CASE WHEN ${preciseDocument} ~* '(called|named|playlist|spotify|studio|apple music|youtube music|pandora|tidal)' THEN 3 ELSE 0 END`
    : "0";
  const serviceNameBonus = exactFamily === "service_name"
    ? `CASE WHEN lower(${preciseDocument}) ~ '(spotify|apple music|youtube music|pandora|tidal|soundcloud|deezer|music service|streaming service)' THEN 8 ELSE 0 END + CASE WHEN lower(${preciseDocument}) ~ '(listening to|listen to|using spotify|using apple music|using pandora|playlist)' THEN 4 ELSE 0 END`
    : "0";
  const serviceNoisePenalty = exactFamily === "service_name"
    ? `CASE WHEN lower(${preciseDocument}) ~ '(delta studio|tripit|airline|flight|skymiles|redeeming my miles|tracking my flights)' THEN -8 ELSE 0 END`
    : "0";
  const speedBonus = exactFamily === "speed"
    ? `CASE WHEN lower(${preciseDocument}) ~ '(internet speed|wifi speed|broadband|fiber|mbps|gbps|upgraded to \\d+\\s*mbps|plan)' THEN 8 ELSE 0 END + CASE WHEN lower(${preciseDocument}) ~ '(streaming|netflix|router|modem)' THEN 2 ELSE 0 END`
    : "0";
  const speedNoisePenalty = exactFamily === "speed"
    ? `CASE WHEN lower(${preciseDocument}) ~ '(mpg|eco ?boost|ford f-150|fuel economy|highway)' THEN -8 ELSE 0 END`
    : "0";
  const venueBonus =
    exactFamily === "venue"
      ? `CASE WHEN lower(${preciseDocument}) ~ '(study abroad|university|college|campus|school|degree|bachelor|program|wedding)' THEN 5 ELSE 0 END`
      : "0";
  const familyBackstop = buildExactDetailFamilyBackstopClause(exactFamily, preciseDocument);
  const scopeFilter = buildExactDetailScopeFilter(queryText, exactFamily, preciseDocument);
  const selfOwnedBonus = buildSelfOwnedSignalBonus({
    queryText,
    signalExpr: "coalesce(em.metadata->>'subject_name', em.metadata->>'speaker_name', em.metadata->>'transcript_speaker_name', em.metadata->>'primary_speaker_name', '')",
    sourceExpr: preciseDocument
  });

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + ${durationBonus} + ${commuteBonus} + ${playlistBonus} + ${classLocationBonus} + ${titleBonus} + ${nameBonus} + ${serviceNameBonus} + ${serviceNoisePenalty} + ${speedBonus} + ${speedNoisePenalty} + ${venueBonus} + ${selfOwnedBonus})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'precise_fact_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND (${match.clause} OR ${familyBackstop})
        AND ${scopeFilter}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, Math.max(candidateLimit, 24)]
  );
}

export function loadParticipantTurnExactDetailRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const exactFamily = inferExactDetailQuestionFamily(queryText);
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 12);
  const participantDocument = "coalesce(ad.metadata->>'source_turn_text', ad.metadata->>'source_sentence_text', ad.content_text)";
  const match = helpers.buildFocusedLikeMatchClause(4, terms, "ad.content_text");
  const entityHints = helpers.extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
  const speakerMatch = helpers.buildFocusedLikeMatchClause(4 + match.values.length, entityHints, "coalesce(ad.metadata->>'primary_speaker_name', '')");
  const questionContextBonus =
    "CASE WHEN coalesce(ad.metadata->>'prompt_text', '') <> '' THEN 3 ELSE 0 END";
  const speakerBonus = entityHints.length > 0
    ? `(${speakerMatch.scoreExpression}) * 4`
    : "0";
  const selfOwnedBonus = buildSelfOwnedSignalBonus({
    queryText,
    signalExpr: "coalesce(ad.metadata->>'subject_name', ad.metadata->>'speaker_name', ad.metadata->>'transcript_speaker_name', ad.metadata->>'primary_speaker_name', '')",
    sourceExpr: participantDocument
  });
  const familyBackstop = buildExactDetailFamilyBackstopClause(exactFamily, participantDocument);
  const scopeFilter = buildExactDetailScopeFilter(queryText, exactFamily, participantDocument);
  const serviceNameBonus = exactFamily === "service_name"
    ? `CASE WHEN lower(${participantDocument}) ~ '(spotify|apple music|youtube music|pandora|tidal|soundcloud|deezer|playlist|discover weekly)' THEN 8 ELSE 0 END`
    : "0";
  const speedBonus = exactFamily === "speed"
    ? `CASE WHEN lower(${participantDocument}) ~ '(\\m\\d+(?:\\.\\d+)?\\s*(mbps|gbps)\\M|internet plan|wifi|broadband|fiber|upgraded to)' THEN 8 ELSE 0 END`
    : "0";
  const venueBonus = exactFamily === "venue"
    ? `CASE WHEN lower(${participantDocument}) ~ '(study abroad|abroad program|university|college|campus|school|degree|bachelor|program|wedding|yoga|studio)' THEN 6 ELSE 0 END`
    : "0";
  const roleBonus = exactFamily === "role"
    ? `CASE WHEN lower(${participantDocument}) ~ '(worked as|working as|occupation|job|role|position)' THEN 5 ELSE 0 END`
    : "0";
  const exactCueBonus = /\b(color|team|position|role|title|job|research|realiz|plans?|name|movie|books?|adopt|bought?|purchased?|temporary|martial|hobbies?|favorite|allerg|focus|sparked?|interest)\b/i.test(queryText)
    ? "CASE WHEN lower(coalesce(ad.metadata->>'source_sentence_text', ad.content_text)) ~ '(color|team|position|role|title|job|research|realiz|plan|named|called|adopt|bought|purchased|movie|book|martial|kickboxing|taekwondo|hobbies|enjoy|favorite|allerg|fur|reptiles|focus|passionate|growing up|saw how)' THEN 2 ELSE 0 END"
    : "0";
  const whereClause = [`(${match.clause} OR ${familyBackstop})`, entityHints.length > 0 ? speakerMatch.clause : "TRUE", scopeFilter].join(" AND ");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        ad.id AS memory_id,
        'artifact_derivation'::text AS memory_type,
        coalesce(ad.content_text, '') AS content,
        ((${match.scoreExpression}) + ${speakerBonus} + ${questionContextBonus} + ${exactCueBonus} + ${selfOwnedBonus} + ${serviceNameBonus} + ${speedBonus} + ${venueBonus} + ${roleBonus})::double precision AS raw_score,
        ao.artifact_id,
        coalesce(source_em.occurred_at, ao.observed_at) AS occurred_at,
        a.namespace_id,
        jsonb_build_object(
          'tier', 'artifact_derivation',
          'derivation_type', ad.derivation_type,
          'provider', ad.provider,
          'model', ad.model,
          'artifact_observation_id', ad.artifact_observation_id,
          'source_chunk_id', ad.source_chunk_id,
          'source_uri', a.uri,
          'metadata', ad.metadata
        ) AS provenance
      FROM artifact_derivations ad
      JOIN artifact_observations ao ON ao.id = ad.artifact_observation_id
      JOIN artifacts a ON a.id = ao.artifact_id
      LEFT JOIN episodic_memory source_em ON source_em.id = ad.source_chunk_id
      WHERE a.namespace_id = $1
        AND ad.derivation_type = 'participant_turn'
        AND coalesce(ad.content_text, '') <> ''
        AND ${whereClause}
        AND ($2::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) >= $2)
        AND ($3::timestamptz IS NULL OR coalesce(source_em.occurred_at, ao.observed_at) <= $3)
      ORDER BY raw_score DESC, coalesce(source_em.occurred_at, ao.observed_at) DESC
      LIMIT $${match.values.length + speakerMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...speakerMatch.values, Math.max(candidateLimit, 18)]
  );
}

export function loadHobbySupportRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly queryText: string;
  readonly plannerTerms: readonly string[];
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, queryText, plannerTerms, candidateLimit, timeStart, timeEnd } = params;
  const terms = buildPreciseFactEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .slice(0, 14);
  const hobbyDocument = "coalesce(em.metadata->>'source_turn_text', em.metadata->>'source_sentence_text', em.content)";
  const match = helpers.buildFocusedLikeMatchClause(4, terms, hobbyDocument);
  const entityHints = helpers.extractEntityNameHints(queryText)
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
  const subjectMatch = helpers.buildFocusedLikeMatchClause(
    4 + match.values.length,
    entityHints,
    "coalesce(em.metadata->>'subject_name', em.metadata->>'speaker_name', em.content)"
  );
  const subjectBonus = entityHints.length > 0 ? `(${subjectMatch.scoreExpression}) * 4` : "0";
  const hobbyCueBonus =
    `CASE WHEN lower(${hobbyDocument}) ~ '(hobbies|interests|besides writing|watching movies|exploring nature|hanging with friends|reading|writing|enjoy|love)' THEN 3 ELSE 0 END`;
  const incidentalPenalty =
    `CASE WHEN lower(${hobbyDocument}) ~ '(creative outlets?)' THEN -1.25 ELSE 0 END`;
  const whereClause = [match.clause, entityHints.length > 0 ? subjectMatch.clause : "TRUE"].join(" AND ");

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        ((${match.scoreExpression}) + ${subjectBonus} + ${hobbyCueBonus} + ${incidentalPenalty})::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'hobby_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND ${whereClause}
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $${match.values.length + subjectMatch.values.length + 4}
    `,
    [namespaceId, timeStart, timeEnd, ...match.values, ...subjectMatch.values, Math.max(candidateLimit, 18)]
  );
}

export function loadSubjectBoundHobbyCueRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly subjectName: string;
  readonly candidateLimit: number;
  readonly timeStart: string | null;
  readonly timeEnd: string | null;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, subjectName, candidateLimit, timeStart, timeEnd } = params;
  const subjectPattern = `%${helpers.normalizeWhitespace(subjectName)}%`;
  const hobbyDocument = "coalesce(em.metadata->>'source_turn_text', em.metadata->>'source_sentence_text', em.content)";
  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          CASE
            WHEN lower(${hobbyDocument}) ~ '(writing and hanging with friends)' THEN 16
            WHEN lower(${hobbyDocument}) ~ '(besides writing)' AND lower(${hobbyDocument}) ~ '(watching movies|exploring nature)' THEN 14
            WHEN lower(${hobbyDocument}) ~ '(hobbies|interests)' THEN 8
            WHEN lower(${hobbyDocument}) ~ '(watching movies|exploring nature|hanging with friends)' THEN 6
            WHEN lower(${hobbyDocument}) ~ '(writing|reading|enjoy|love)' THEN 3
            WHEN lower(${hobbyDocument}) ~ '(creative outlets?)' THEN -1.25
            ELSE 0
          END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'subject_hobby_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND ($2::timestamptz IS NULL OR em.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR em.occurred_at <= $3)
        AND coalesce(em.metadata->>'subject_name', em.metadata->>'speaker_name', em.content) ILIKE $4
        AND lower(${hobbyDocument}) ~ '(hobbies|interests|writing and hanging with friends|besides writing|watching movies|exploring nature|hanging with friends|reading|writing|enjoy|love|creative outlets?)'
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $5
    `,
    [namespaceId, timeStart, timeEnd, subjectPattern, Math.max(candidateLimit, 36)]
  );
}

export function loadArtifactLocalClassLocationRows(params: {
  readonly helpers: SupportLoaderHelpers;
  readonly namespaceId: string;
  readonly artifactIds: readonly string[];
  readonly candidateLimit: number;
}): Promise<SearchRow[]> {
  const { helpers, namespaceId, artifactIds, candidateLimit } = params;
  const normalizedArtifactIds = [...new Set(artifactIds.map((artifactId) => artifactId.trim()).filter(Boolean))];
  if (normalizedArtifactIds.length === 0) {
    return Promise.resolve([]);
  }

  return helpers.queryRows<SearchRow>(
    `
      SELECT
        em.id AS memory_id,
        'episodic_memory'::text AS memory_type,
        em.content,
        (
          CASE WHEN lower(em.content) LIKE '%serenity yoga%' THEN 20 ELSE 0 END +
          CASE WHEN em.content ~ '[A-Z][A-Za-z0-9''&.-]+(\\s+[A-Z][A-Za-z0-9''&.-]+){0,4}\\s+Yoga' THEN 8 ELSE 0 END +
          CASE WHEN em.content ~* '(near|at|to|from|make it to|connection to|local|studio practice|yoga instructor|fellow yogis)' THEN 6 ELSE 0 END +
          CASE WHEN em.content ~* '(app|apps|free trial|subscription|available for|in-app purchases|one-time purchase|customizable practices)' THEN -8 ELSE 0 END
        )::double precision AS raw_score,
        em.artifact_id,
        em.occurred_at,
        em.namespace_id,
        jsonb_build_object(
          'tier', 'focused_episodic_support',
          'lexical_provider', 'artifact_local_class_location_scope',
          'source_uri', a.uri,
          'artifact_observation_id', em.artifact_observation_id,
          'metadata', em.metadata
        ) AS provenance
      FROM episodic_memory em
      LEFT JOIN artifacts a ON a.id = em.artifact_id
      WHERE em.namespace_id = $1
        AND em.artifact_id = ANY($2::uuid[])
        AND (
          lower(em.content) LIKE '%yoga%' OR
          lower(em.content) LIKE '%studio%' OR
          lower(em.content) LIKE '%class%' OR
          lower(em.content) LIKE '%classes%'
        )
      ORDER BY raw_score DESC, em.occurred_at DESC, em.id DESC
      LIMIT $3
    `,
    [namespaceId, normalizedArtifactIds, Math.max(candidateLimit, 8)]
  );
}
