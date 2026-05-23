export const GLINER_RELEX_EXTRACTOR = "gliner_relex_v1";
export const GLINER_RELEX_SCHEMA_VERSION = "relex_relation_schema_v1";
export const GLINER_RELEX_MODEL_ID = "knowledgator/gliner-relex-large-v1.0";

export const RELEX_RELATION_LABELS = [
  "friend of",
  "works with",
  "works at",
  "worked at",
  "works on",
  "lives in",
  "lived in",
  "member of",
  "met through",
  "sibling of",
  "romantic partner of",
  "prefers",
  "favorite of",
  "owns",
  "bought",
  "supports",
  "advises",
  "inspired by",
  "caused by",
  "because of",
  "occurred on",
  "participated in",
  "family activity with",
  "about",
  "identity support of"
] as const;

export const RELEX_RELATION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "friend of": "social friendship or close-friend relationship between people",
  "works with": "coworker, collaborator, or regular work relationship between people",
  "works at": "current employer or organization affiliation",
  "worked at": "historical employer or previous organization affiliation",
  "works on": "current project, product, initiative, app, or creative work involvement",
  "lives in": "current residence, base location, or living location",
  "lived in": "historical residence or previous living location",
  "member of": "membership in a club, org, team, group, identity group, or community",
  "met through": "how two people know each other through a person, place, event, org, or activity",
  "sibling of": "brother, sister, or sibling relationship",
  "romantic partner of": "dating, partner, boyfriend, girlfriend, spouse, or romantic relationship",
  prefers: "explicit preference, liking, preferred food, favorite category, or taste",
  "favorite of": "explicit favorite item, title, book, food, show, song, place, or activity",
  owns: "ownership, possession, pet ownership, vehicle ownership, or owned item",
  bought: "purchase, acquired item, bought object, or shopping event",
  supports: "explicit support, help, allyship, encouragement, or assistance relation",
  advises: "advice, mentorship, guidance, coaching, or counsel relation",
  "inspired by": "inspiration source, recommendation source, or motivational source",
  "caused by": "cause, reason, origin, or explicit why explanation",
  "because of": "reason clause, motivation, or because relation",
  "occurred on": "event-local date, time, month, year, or temporal anchor",
  "participated in": "activity, event, class, trip, course, hobby, or participation",
  "family activity with": "family or household activity involving people and an activity",
  about: "media, book, show, project, discussion, artwork, or content topic relation",
  "identity support of": "support, allyship, or evidence related to an identity without inferring membership"
};

export interface RelexPredicateMapping {
  readonly predicate: string;
  readonly family: string;
  readonly answerShape: "entity" | "value" | "date" | "reason" | "list_member";
  readonly metadata: Record<string, unknown>;
}

function normalizeLabel(value: string | undefined): string {
  return String(value ?? "")
    .split(/::|:/u)[0]
    .trim()
    .toLowerCase()
    .replace(/_/gu, " ")
    .replace(/\s+/gu, " ");
}

export function mapRelexRelationLabel(relation: string | undefined): RelexPredicateMapping | null {
  const normalized = normalizeLabel(relation);
  const metadata: Record<string, unknown> = {
    source_relation_label: normalized || null,
    relex_relation_schema_version: GLINER_RELEX_SCHEMA_VERSION
  };
  switch (normalized) {
    case "friend of":
    case "friend":
    case "friends with":
      return { predicate: "friend_of", family: "relationship_status", answerShape: "entity", metadata };
    case "works with":
    case "coworker of":
    case "collaborates with":
      return { predicate: "works_with", family: "relationship_status", answerShape: "entity", metadata };
    case "works at":
    case "employed by":
      return { predicate: "works_at", family: "affiliation", answerShape: "entity", metadata };
    case "worked at":
    case "previously worked at":
      return { predicate: "worked_at", family: "affiliation", answerShape: "entity", metadata };
    case "works on":
    case "working on":
      return { predicate: "works_on", family: "project_work", answerShape: "entity", metadata };
    case "lives in":
    case "resides in":
    case "currently in":
      return { predicate: "lives_in", family: "residence", answerShape: "entity", metadata };
    case "lived in":
    case "used to live in":
      return { predicate: "lived_in", family: "residence", answerShape: "entity", metadata };
    case "member of":
      return { predicate: "member_of", family: "identity_or_affiliation", answerShape: "entity", metadata };
    case "met through":
      return { predicate: "met_through", family: "relationship_status", answerShape: "entity", metadata };
    case "sibling of":
    case "brother of":
    case "sister of":
      return { predicate: "sibling_of", family: "relationship_status", answerShape: "entity", metadata };
    case "romantic partner of":
    case "partner of":
    case "dating":
    case "dated":
    case "girlfriend of":
    case "boyfriend of":
      return { predicate: "was_with", family: "relationship_status", answerShape: "entity", metadata: { ...metadata, relationship_kind: "romantic" } };
    case "prefers":
      return { predicate: "prefers", family: "preference", answerShape: "value", metadata };
    case "favorite of":
      return { predicate: "favorite_of", family: "preference", answerShape: "value", metadata };
    case "owns":
      return { predicate: "owns", family: "owned_object", answerShape: "value", metadata };
    case "bought":
      return { predicate: "bought", family: "purchase", answerShape: "value", metadata };
    case "supports":
      return { predicate: "supports", family: "support_advice_inspiration", answerShape: "entity", metadata };
    case "advises":
      return { predicate: "advises", family: "support_advice_inspiration", answerShape: "entity", metadata };
    case "inspired by":
      return { predicate: "inspired_by", family: "support_advice_inspiration", answerShape: "entity", metadata };
    case "caused by":
      return { predicate: "caused_by", family: "causal_reason", answerShape: "reason", metadata };
    case "because of":
      return { predicate: "because_of", family: "causal_reason", answerShape: "reason", metadata };
    case "occurred on":
      return { predicate: "occurred_on", family: "date_activity", answerShape: "date", metadata };
    case "participated in":
      return { predicate: "participated_in", family: "date_activity", answerShape: "entity", metadata };
    case "family activity with":
      return { predicate: "family_activity_with", family: "family_social_activity", answerShape: "entity", metadata };
    case "about":
      return { predicate: "about", family: "media_about", answerShape: "value", metadata };
    case "identity support of":
      return { predicate: "identity_support_of", family: "identity_support", answerShape: "entity", metadata };
    default:
      return null;
  }
}

