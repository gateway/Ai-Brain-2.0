import { normalizeWhitespace } from "../identity/canonicalization.js";

export type RelationshipOntologyPredicate =
  | "friend_of"
  | "introduced_by"
  | "met_at"
  | "met_through"
  | "worked_with"
  | "social_group_member"
  | "unknown";

export interface RelationshipSupportBundle {
  readonly subject: string;
  readonly object: string | null;
  readonly predicate: RelationshipOntologyPredicate;
  readonly place: string | null;
  readonly timeHint: string | null;
  readonly status: "current" | "historical" | "unknown";
  readonly sourceTrailCount: number;
  readonly supportText: string;
}

export function inferRelationshipPredicate(text: string): RelationshipOntologyPredicate {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (/\bgroup\b|\bsocial\s+circle\b|\bcommunity\b/u.test(normalized)) return "social_group_member";
  if (/\bintroduc(?:e|ed|tion|es)\b/u.test(normalized)) return "introduced_by";
  if (/\bmet\s+(?:at|in)\b|\bwhere\s+did\s+(?:i|we)\s+meet\b/u.test(normalized)) return "met_at";
  if (/\bmet\s+through\b|\bthrough\s+[a-z]+\b/u.test(normalized)) return "met_through";
  if (/\b(?:work|worked)\s+(?:with|at|for)\b|\bcowork(?:er|ing)?\b/u.test(normalized)) return "worked_with";
  if (/\bfriends?\b|\bmutual\s+friends?\b/u.test(normalized)) return "friend_of";
  return "unknown";
}

export function buildRelationshipSupportBundle(params: {
  readonly subject: string;
  readonly object?: string | null;
  readonly text: string;
  readonly places?: readonly string[];
  readonly sourceTrailCount?: number;
}): RelationshipSupportBundle {
  const time = params.text.match(/\b(?:19|20)\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/iu)?.[0] ?? null;
  return {
    subject: normalizeWhitespace(params.subject),
    object: params.object ? normalizeWhitespace(params.object) : null,
    predicate: inferRelationshipPredicate(params.text),
    place: params.places?.[0] ?? null,
    timeHint: time,
    status: /\b(?:used to|formerly|old|historical|back then|stopped)\b/iu.test(params.text) ? "historical" : "unknown",
    sourceTrailCount: params.sourceTrailCount ?? 0,
    supportText: normalizeWhitespace(params.text)
  };
}
