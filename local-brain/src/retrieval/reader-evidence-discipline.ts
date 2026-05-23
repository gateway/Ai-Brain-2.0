import type { RecallResponse } from "./types.js";

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function distinctiveQueryTerms(queryText: string | null | undefined): string[] {
  const stop = new Set([
    "what", "which", "where", "when", "why", "how", "does", "did", "has", "have", "had", "would",
    "could", "might", "likely", "kind", "type", "with", "from", "about", "their", "his", "her",
    "the", "and", "for", "that", "this", "into", "more", "than", "others", "based", "considering"
  ]);
  return (queryText?.toLowerCase().match(/[a-z][a-z'’-]{2,}/gu) ?? [])
    .map((term) => term.replace(/[’']/gu, ""))
    .filter((term) => term.length >= 4 && !stop.has(term));
}

function isUnsupportedClaimShape(queryText: string | null | undefined, claimText: string | null | undefined): boolean {
  const normalized = normalize(claimText ?? "");
  if (!normalized) {
    return true;
  }
  if (/^(?:None\.?|No authoritative evidence\b|No authoritative evidence matched\b|I don't know\b|Unknown\b)/iu.test(normalized)) {
    return true;
  }
  if (/\b(?:canonical_rebuild|media_mentions|source_sentence_text|subject_entity_id|subject_name|unknown)\b/iu.test(normalized)) {
    return true;
  }
  if (/^\s*[\[{]/u.test(normalized) || /(?:\{|\})\s*$/.test(normalized)) {
    return true;
  }
  const query = normalize(queryText ?? "");
  const lowerClaim = normalized.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (normalized.length > 140) {
    const anchors = distinctiveQueryTerms(query).filter((term) => !/^[a-z]+s$/.test(term) || !lowerClaim.includes(term.slice(0, -1)));
    const matched = anchors.filter((term) => lowerClaim.includes(term) || (term.endsWith("s") && lowerClaim.includes(term.slice(0, -1))));
    if (anchors.length >= 2 && matched.length === 0) {
      return true;
    }
  }
  if (/\b(?:where|from)\b/iu.test(lowerQuery) && /\b(?:dogs?|pets?|pupp(?:y|ies))\b/iu.test(lowerQuery) && !/\b(?:dog|pet|pupp|adopt|shelter|rescue|from|got)\b/iu.test(lowerClaim)) {
    return true;
  }
  return false;
}

export function requiresSourceBoundTruthDiscipline(params: {
  readonly queryText: string;
  readonly ownerFamily: string | null | undefined;
  readonly winner: string | null | undefined;
}): boolean {
  const normalized = normalize(params.queryText).toLowerCase();
  const winner = params.winner ?? "";
  if (![
    "canonical_report",
    "canonical_profile",
    "canonical_narrative",
    "canonical_list_set",
    "canonical_exact_detail",
    "canonical_temporal",
    "top_snippet",
    "fallback_derived"
  ].includes(winner)) {
    return false;
  }
  if (["exact_detail", "temporal", "list_set"].includes(params.ownerFamily ?? "")) {
    return true;
  }
  return /\b(?:favorite|prefer|preference|interests?|interested|dreams?|goals?|health|suspected|condition|doctor|weight|position|role|project|items?|bought|purchased|acquired|car|pets?|dogs?|cats?|turtles?|books?|meat|food|married|relationship status|live|lives|living|connecticut|employ|employees?|shop|store|patriotic|civic|religious|spiritual|political|personality|considered|motivated?|motivation|inspired?|symboli[sz]e|symbolic|feel|felt|reaction|why|reason|because|when|how\s+(?:long|often|many|much|did|does))\b/iu.test(
    normalized
  );
}

export function sourceBoundEvidenceIsPresent(params: {
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly evidenceCount: number;
  readonly resultCount: number;
  readonly queryText?: string | null;
  readonly claimText?: string | null;
  readonly ownerFamily?: string | null;
  readonly winner?: string | null;
  readonly renderContractSelected?: string | null;
  readonly supportObjectType?: string | null;
}): boolean {
  const assessment = params.answerAssessment;
  if (!assessment || params.evidenceCount <= 0 || params.resultCount <= 0) {
    return false;
  }
  if (isUnsupportedClaimShape(params.queryText, params.claimText)) {
    return false;
  }
  const canTrustTypedTemporalRelativeSupport =
    params.ownerFamily === "temporal" &&
    params.winner === "canonical_temporal" &&
    params.renderContractSelected === "temporal_relative_day" &&
    params.supportObjectType === "TemporalEventSupport";
  if (canTrustTypedTemporalRelativeSupport) {
    return true;
  }
  if (
    params.winner === "canonical_list_set" &&
    /\b(?:both|share|shared|common|city|interests?|destress|stress|volunteer)\b/iu.test(params.queryText ?? "") &&
    params.evidenceCount >= 2
  ) {
    return true;
  }
  if (
    ["canonical_report", "canonical_profile", "canonical_narrative", "canonical_list_set"].includes(params.winner ?? "") &&
    (!params.renderContractSelected || !params.supportObjectType)
  ) {
    return false;
  }
  return assessment.subjectMatch === "matched" && assessment.sufficiency === "supported";
}

export function evaluateSourceBoundReaderEvidenceDiscipline(params: {
  readonly queryText: string;
  readonly ownerFamily: string | null | undefined;
  readonly winner: string | null | undefined;
  readonly answerAssessment: RecallResponse["meta"]["answerAssessment"];
  readonly evidenceCount: number;
  readonly resultCount: number;
  readonly claimText?: string | null;
  readonly renderContractSelected?: string | null;
  readonly supportObjectType?: string | null;
}): {
  readonly required: boolean;
  readonly present: boolean;
  readonly blocked: boolean;
  readonly status?: string;
  readonly reason?: string;
} {
  const required = requiresSourceBoundTruthDiscipline({
    queryText: params.queryText,
    ownerFamily: params.ownerFamily,
    winner: params.winner
  });
  const present = required
    ? sourceBoundEvidenceIsPresent({
        answerAssessment: params.answerAssessment,
        evidenceCount: params.evidenceCount,
        resultCount: params.resultCount,
        queryText: params.queryText,
        claimText: params.claimText,
        ownerFamily: params.ownerFamily,
        winner: params.winner,
        renderContractSelected: params.renderContractSelected,
        supportObjectType: params.supportObjectType
      })
    : false;
  if (!required) {
    return { required: false, present: false, blocked: false };
  }
  if (present) {
    return {
      required,
      present,
      blocked: false,
      status: "source_bound_evidence_present"
    };
  }
  return {
    required,
    present,
    blocked: true,
    status: "no_subject_bound_evidence",
    reason: "no_subject_bound_evidence"
  };
}

export function evaluateSourceBoundReaderEvidenceDisciplineForTest(params: {
  readonly queryText: string;
  readonly ownerFamily: string | null | undefined;
  readonly winner: string | null | undefined;
  readonly sufficiency: "missing" | "weak" | "supported" | "contradicted";
  readonly subjectMatch: "matched" | "mixed" | "mismatched" | "unknown";
  readonly evidenceCount: number;
  readonly resultCount: number;
  readonly renderContractSelected?: string | null;
  readonly supportObjectType?: string | null;
}): ReturnType<typeof evaluateSourceBoundReaderEvidenceDiscipline> {
  return evaluateSourceBoundReaderEvidenceDiscipline({
    queryText: params.queryText,
    ownerFamily: params.ownerFamily,
    winner: params.winner,
    evidenceCount: params.evidenceCount,
    resultCount: params.resultCount,
    answerAssessment: {
      confidence: params.sufficiency === "supported" ? "confident" : params.sufficiency === "weak" ? "weak" : "missing",
      sufficiency: params.sufficiency,
      reason: "test",
      lexicalCoverage: params.evidenceCount > 0 ? 1 : 0,
      matchedTerms: [],
      totalTerms: 0,
      evidenceCount: params.evidenceCount,
      directEvidence: params.evidenceCount > 0,
      subjectMatch: params.subjectMatch,
      matchedParticipants: [],
      missingParticipants: [],
      foreignParticipants: []
    },
    claimText: "supported evidence",
    renderContractSelected: params.renderContractSelected,
    supportObjectType: params.supportObjectType
  });
}
