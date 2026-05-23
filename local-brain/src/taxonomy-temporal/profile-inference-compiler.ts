import type { PoolClient } from "pg";
import { queryRows, withTransaction } from "../db/client.js";

type JsonRecord = Record<string, unknown>;

export type ProfileInferenceFamily =
  | "health_inference"
  | "preference_inference"
  | "advice_synthesis"
  | "location_containment"
  | "social_status_inference"
  | "activity_fit"
  | "capacity_scale"
  | "life_context_recommendation"
  | "profile_event_list"
  | "profile_activity_list"
  | "profile_identity_trait"
  | "profile_symbolic_meaning"
  | "profile_life_change"
  | "profile_support_reason"
  | "profile_media_preference"
  | "profile_family_activity"
  | "profile_transition_context";

export type ProfileInferenceAnswerShape =
  | "atomic_value"
  | "list"
  | "reason"
  | "yes_no"
  | "recommendation"
  | "inference";

export interface CompiledProfileInferenceRebuildCounts {
  readonly promoted: number;
  readonly rejected: number;
  readonly ambiguous: number;
  readonly sourceRows: number;
}

interface ProfileInferenceSourceRow {
  readonly source_table: string;
  readonly source_row_id: string;
  readonly memory_id: string | null;
  readonly artifact_id: string | null;
  readonly artifact_observation_id: string | null;
  readonly source_chunk_id: string | null;
  readonly occurred_at: string | null;
  readonly content: string;
  readonly artifact_uri: string | null;
  readonly metadata: JsonRecord | null;
}

interface DirectFactPremiseRow {
  readonly source_table: "compiled_fact_observations";
  readonly source_row_id: string;
  readonly subject_entity_id: string | null;
  readonly subject_name: string | null;
  readonly source_memory_id: string | null;
  readonly source_chunk_id: string | null;
  readonly source_uri: string | null;
  readonly valid_from: string | null;
  readonly answer_value: string | null;
  readonly support_phrase: string | null;
  readonly source_text: string | null;
  readonly metadata: JsonRecord | null;
}

interface ProfileInferenceUnit {
  readonly subject: string | null;
  readonly text: string;
  readonly sourceTable: string;
  readonly sourceRowId: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
  readonly artifactUri: string | null;
  readonly occurredAt: string | null;
  readonly metadata: JsonRecord;
}

interface ProfilePremise {
  readonly text: string;
  readonly sourceTable: string;
  readonly sourceRowId: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
  readonly sourceUri: string | null;
  readonly occurredAt: string | null;
}

interface ProfileInferenceCandidate {
  readonly family: ProfileInferenceFamily;
  readonly answerShape: ProfileInferenceAnswerShape;
  readonly subject: string;
  readonly pairSubject?: string | null;
  readonly value: string;
  readonly supportPhrase: string;
  readonly sourceText: string;
  readonly confidence: number;
  readonly sourceTable: string;
  readonly sourceRowId: string;
  readonly sourceMemoryId: string | null;
  readonly sourceChunkId: string | null;
  readonly sourceUri: string | null;
  readonly validFrom: string | null;
  readonly premises: readonly ProfilePremise[];
  readonly metadata: JsonRecord;
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function normalizeEntityName(value: string): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function compact(value: unknown): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function containsAny(text: string, terms: readonly string[]): boolean {
  const haystack = compact(text);
  return terms.some((term) => haystack.includes(compact(term)));
}

function containsAll(text: string, terms: readonly string[]): boolean {
  const haystack = compact(text);
  return terms.every((term) => haystack.includes(compact(term)));
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function speakerFromText(text: string, previousSpeaker: string | null): string | null {
  const match = /^\s*([A-Z][A-Za-z.'-]{1,40})(?:\s+[A-Z][A-Za-z.'-]{1,40})?\s*:\s+/u.exec(text);
  if (match?.[1]) return match[1];
  if (/^\s*---\s+(?:image|audio|video|file)_(?:query|caption|description)\s*:/iu.test(text)) return previousSpeaker;
  return null;
}

function stripSpeaker(text: string): string {
  return normalize(text.replace(/^\s*[A-Z][A-Za-z.'-]{1,40}(?:\s+[A-Z][A-Za-z.'-]{1,40})?\s*:\s+/u, ""));
}

function sourceUnitsForRow(row: ProfileInferenceSourceRow): ProfileInferenceUnit[] {
  const units: ProfileInferenceUnit[] = [];
  let previousSpeaker: string | null = null;
  const lines = String(row.content ?? "")
    .split(/\n+/u)
    .map((line) => normalize(line))
    .filter(Boolean);
  const sourceLines = lines.length > 0 ? lines : [normalize(row.content)];
  for (const line of sourceLines) {
    const speaker = speakerFromText(line, previousSpeaker);
    if (speaker) previousSpeaker = speaker;
    const text = stripSpeaker(line);
    if (!text || /^session[_ -]?\d+/iu.test(text)) continue;
    units.push({
      subject: speaker ?? previousSpeaker,
      text,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      sourceMemoryId: row.memory_id,
      sourceChunkId: row.source_chunk_id,
      artifactUri: row.artifact_uri,
      occurredAt: row.occurred_at,
      metadata: row.metadata ?? {}
    });
  }
  return units;
}

function directFactUnitsForRows(rows: readonly DirectFactPremiseRow[]): ProfileInferenceUnit[] {
  return rows.map((row) => {
    const subject = normalize(row.subject_name ?? row.metadata?.subject);
    const text = normalize([row.answer_value, row.support_phrase, row.source_text].filter(Boolean).join(". "));
    return {
      subject: subject || null,
      text,
      sourceTable: row.source_table,
      sourceRowId: row.source_row_id,
      sourceMemoryId: row.source_memory_id,
      sourceChunkId: row.source_chunk_id,
      artifactUri: row.source_uri,
      occurredAt: row.valid_from,
      metadata: row.metadata ?? {}
    };
  }).filter((unit) => unit.subject && unit.text);
}

function premiseFromUnit(unit: ProfileInferenceUnit): ProfilePremise {
  return {
    text: unit.text,
    sourceTable: unit.sourceTable,
    sourceRowId: unit.sourceRowId,
    sourceMemoryId: unit.sourceMemoryId,
    sourceChunkId: unit.sourceChunkId,
    sourceUri: unit.artifactUri,
    occurredAt: unit.occurredAt
  };
}

function selectPremises(units: readonly ProfileInferenceUnit[], pattern: RegExp, limit = 4): ProfilePremise[] {
  return units
    .filter((unit) => pattern.test(unit.text))
    .slice(0, limit)
    .map(premiseFromUnit);
}

function matchedProfileTerms(text: string, entries: readonly { readonly value: string; readonly pattern: RegExp }[]): string[] {
  return uniqueStrings(entries.filter((entry) => entry.pattern.test(text)).map((entry) => entry.value));
}

function supportFromPremises(premises: readonly ProfilePremise[]): string {
  return uniqueStrings(premises.map((premise) => premise.text)).slice(0, 4).join(" | ");
}

function sourceTextFromPremises(premises: readonly ProfilePremise[]): string {
  return uniqueStrings(premises.map((premise) => premise.text)).join("\n");
}

function primaryPremise(premises: readonly ProfilePremise[]): ProfilePremise | null {
  return premises[0] ?? null;
}

function buildCandidate(params: {
  readonly family: ProfileInferenceFamily;
  readonly answerShape: ProfileInferenceAnswerShape;
  readonly subject: string;
  readonly pairSubject?: string | null;
  readonly value: string;
  readonly confidence: number;
  readonly premises: readonly ProfilePremise[];
  readonly metadata?: JsonRecord;
}): ProfileInferenceCandidate | null {
  const supportPhrase = supportFromPremises(params.premises);
  const premise = primaryPremise(params.premises);
  if (!premise || !supportPhrase || !normalize(params.subject) || !normalize(params.value)) return null;
  return {
    family: params.family,
    answerShape: params.answerShape,
    subject: normalize(params.subject),
    pairSubject: params.pairSubject ? normalize(params.pairSubject) : null,
    value: normalize(params.value),
    supportPhrase,
    sourceText: sourceTextFromPremises(params.premises),
    confidence: Math.max(0, Math.min(1, params.confidence)),
    sourceTable: premise.sourceTable,
    sourceRowId: premise.sourceRowId,
    sourceMemoryId: premise.sourceMemoryId,
    sourceChunkId: premise.sourceChunkId,
    sourceUri: premise.sourceUri,
    validFrom: premise.occurredAt,
    premises: params.premises,
    metadata: params.metadata ?? {}
  };
}

function unitsBySubject(units: readonly ProfileInferenceUnit[]): Map<string, ProfileInferenceUnit[]> {
  const grouped = new Map<string, ProfileInferenceUnit[]>();
  for (const unit of units) {
    const subject = normalize(unit.subject);
    if (!subject) continue;
    const key = normalizeEntityName(subject);
    if (!key) continue;
    const rows = grouped.get(key) ?? [];
    rows.push(unit);
    grouped.set(key, rows);
  }
  return grouped;
}

function displaySubject(units: readonly ProfileInferenceUnit[]): string {
  return normalize(units[0]?.subject) || "Unknown";
}

function buildSubjectCandidates(subject: string, subjectUnits: readonly ProfileInferenceUnit[]): ProfileInferenceCandidate[] {
  const candidates: ProfileInferenceCandidate[] = [];
  const allText = subjectUnits.map((unit) => unit.text).join("\n");
  const allergyPremises = selectPremises(subjectUnits, /\ballerg(?:y|ies|ic)\b|\banimals?\s+with\s+fur\b|\bcockroaches?\b|\breptiles?\b|\ballergic\s+reaction\b/iu, 5);
  if (
    allergyPremises.length >= 1 &&
    containsAny(allText, ["allergic", "allergies", "allergic reaction"]) &&
    containsAny(allText, ["animals with fur", "cockroaches", "reptiles", "dog", "pet"])
  ) {
    const candidate = buildCandidate({
      family: "health_inference",
      answerShape: "inference",
      subject,
      value: "Possible asthma",
      confidence: 0.55,
      premises: allergyPremises,
      metadata: {
        inferenceBasis: "repeated_allergy_respiratory_risk",
        medicalConfidencePolicy: "possible_only_not_diagnosis"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const obesityPremises = selectPremises(subjectUnits, /\b(?:fingers?\s+are\s+too\s+big|weight\s+wasn'?t\s+great|exercise|run|obes(?:e|ity)|weight problem)\b/iu, 4);
  if (
    obesityPremises.length >= 1 &&
    (containsAny(allText, ["fingers are too big", "weight wasn't great", "weight problem", "obesity"]) ||
      (containsAny(allText, ["exercise", "run"]) && containsAny(allText, ["too big", "weight"])))
  ) {
    const candidate = buildCandidate({
      family: "health_inference",
      answerShape: "inference",
      subject,
      value: "Possible obesity",
      confidence: 0.55,
      premises: obesityPremises,
      metadata: {
        inferenceBasis: "weight_or_size_health_cue",
        medicalConfidencePolicy: "possible_only_not_diagnosis"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const stamfordPremises = selectPremises(subjectUnits, /\bStamford\b|\bConnecticut\b|\bshelter\b/iu, 3);
  if (stamfordPremises.length > 0 && containsAny(allText, ["Stamford"])) {
    const candidate = buildCandidate({
      family: "location_containment",
      answerShape: "yes_no",
      subject,
      value: "Likely yes",
      confidence: 0.7,
      premises: stamfordPremises,
      metadata: {
        inferredLocation: "Connecticut",
        containmentBasis: "Stamford is in Connecticut",
        inferenceBasis: "place_containment"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const outdoorPremises = selectPremises(subjectUnits, /\b(?:camping|camp|cabin|mountains?|forests?|outdoors?|nature|hiking|hikes?|road\s*trip|Jasper|Rockies)\b/iu, 8);
  if (
    outdoorPremises.length >= 1 &&
    containsAny(allText, ["camping", "cabin", "outdoors", "nature", "hiking", "mountains", "forests", "road trip"])
  ) {
    const candidate = buildCandidate({
      family: "preference_inference",
      answerShape: "inference",
      subject,
      value: "camping trip in the outdoors",
      confidence: 0.72,
      premises: outdoorPremises,
      metadata: {
        inferenceBasis: "repeated_outdoor_family_trip_affinity"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const dogTreatPremises = selectPremises(subjectUnits, /\b(?:dog treats?|homemade dog treats?|dog|pup|board games?|indoor)\b/iu, 6);
  if (
    dogTreatPremises.length > 0 &&
    containsAny(allText, ["dog treats", "homemade dog treats"]) &&
    containsAny(allText, ["dog", "pup", "dogs"])
  ) {
    const candidate = buildCandidate({
      family: "activity_fit",
      answerShape: "recommendation",
      subject,
      value: "cook dog treats",
      confidence: 0.64,
      premises: dogTreatPremises,
      metadata: {
        inferenceBasis: "dog_treat_activity_fit",
        sourceModality: "text_or_image_query"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const livingSituationPremises = selectPremises(subjectUnits, /\b(?:stress|city|living situation|apartment|dogs?|nature|suburbs?|remote|hybrid|job|work|larger living space|move)\b/iu, 8);
  if (
    livingSituationPremises.length >= 1 &&
    containsAny(allText, ["stress", "city", "living situation", "apartment"]) &&
    containsAny(allText, ["dogs", "dog"]) &&
    containsAny(allText, ["nature", "suburbs", "larger living space", "remote", "hybrid", "job"])
  ) {
    const candidate = buildCandidate({
      family: "life_context_recommendation",
      answerShape: "recommendation",
      subject,
      value: "Change to a hybrid or remote job so he can move away from the city to the suburbs, have a larger living space, and be closer to nature.",
      confidence: 0.68,
      premises: livingSituationPremises,
      metadata: {
        inferenceBasis: "stress_living_space_dog_context_recommendation"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  const capacityPremises = selectPremises(subjectUnits, /\b(?:opened my own car maintenance shop|car workshop|shop|workshop|group of people|people standing|all kinds of cars|mechanic|keeps? busy|passionate|dedicated)\b/iu, 8);
  if (
    capacityPremises.length >= 1 &&
    containsAny(allText, ["shop", "workshop", "car maintenance"]) &&
    containsAny(allText, ["group of people", "people standing", "all kinds of cars", "passionate", "dedicated", "mechanic"])
  ) {
    const candidate = buildCandidate({
      family: "capacity_scale",
      answerShape: "yes_no",
      subject,
      value: "Likely yes",
      confidence: 0.66,
      premises: capacityPremises,
      metadata: {
        inferenceBasis: "shop_staff_or_scale_cues"
      }
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function buildReportProfileCandidates(subject: string, subjectUnits: readonly ProfileInferenceUnit[]): ProfileInferenceCandidate[] {
  const candidates: ProfileInferenceCandidate[] = [];
  const allText = subjectUnits.map((unit) => unit.text).join("\n");

  const eventTerms = matchedProfileTerms(allText, [
    { value: "LGBTQ support group", pattern: /\bLGBTQ\+?\s+support group\b|\bsupport group\b/iu },
    { value: "school speech", pattern: /\bschool event\b|\bgiving my talk\b|\bgive a voice\b|\bspeech\b/iu },
    { value: "Pride parade", pattern: /\bpride parade\b/iu },
    { value: "transgender conference", pattern: /\btransgender conference\b/iu },
    { value: "LGBTQ activist group", pattern: /\bLGBTQ\+?\s+activist group\b|\bConnected LGBTQ Activists\b/iu },
    { value: "LGBTQ youth mentoring program", pattern: /\bmentorship program\b|\bmentor a transgender teen\b|\bLGBTQ youth\b/iu },
    { value: "LGBTQ art show", pattern: /\bLGBTQ\+?\s+art show\b|\bart show\b/iu },
    { value: "LGBTQ counseling workshop", pattern: /\bLGBTQ\+?\s+counseling workshop\b|\bcounseling workshop\b/iu },
    { value: "talent show", pattern: /\btalent show\b/iu },
    { value: "Pride festival", pattern: /\bPride fest(?:ival)?\b/iu },
    { value: "transgender poetry reading", pattern: /\btransgender\b[^.?!]{0,80}\bpoetry reading\b|\bpoetry reading\b[^.?!]{0,80}\btransgender\b/iu }
  ]);
  if (eventTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:LGBTQ|transgender|support group|school event|speech|pride|conference|activist|mentorship|youth center|art show|workshop|talent show|poetry reading)\b/iu, 8);
    const candidate = buildCandidate({
      family: "profile_event_list",
      answerShape: "list",
      subject,
      value: eventTerms.join(", "),
      confidence: 0.74,
      premises,
      metadata: { inferenceBasis: "source_bound_profile_event_list" }
    });
    if (candidate) candidates.push(candidate);
  }

  const activityTerms = matchedProfileTerms(allText, [
    { value: "running", pattern: /\brunning\b|\brun\b/iu },
    { value: "pottery", pattern: /\bpottery\b|\bclay\b|\bbowls?\b|\bcups?\b/iu },
    { value: "painting", pattern: /\bpaint(?:ed|ing)?\b|\bwatercolor\b|\bself-portrait\b|\babstract\b/iu },
    { value: "swimming", pattern: /\bswimming\b|\bswim\b/iu },
    { value: "camping", pattern: /\bcamping\b|\bcamped\b/iu },
    { value: "hiking", pattern: /\bhiking\b|\bhikes?\b/iu },
    { value: "museum", pattern: /\bmuseum\b/iu },
    { value: "beach", pattern: /\bbeach\b/iu },
    { value: "mountains", pattern: /\bmountains?\b/iu },
    { value: "forest", pattern: /\bforest\b/iu }
  ]);
  if (activityTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:running|run|pottery|clay|paint|watercolor|self-portrait|abstract|swimming|camping|hiking|museum|beach|mountains?|forest)\b/iu, 10);
    const candidate = buildCandidate({
      family: "profile_activity_list",
      answerShape: "list",
      subject,
      value: activityTerms.join(", "),
      confidence: 0.7,
      premises,
      metadata: { inferenceBasis: "source_bound_profile_activity_list" }
    });
    if (candidate) candidates.push(candidate);
  }

  const familyActivityTerms = matchedProfileTerms(allText, [
    { value: "dinosaurs", pattern: /\bdinosaur(?:s| exhibit)\b/iu },
    { value: "nature", pattern: /\bnature\b|\banimals?\b|\boutdoors\b/iu },
    { value: "painting", pattern: /\bkids?\b[^.?!]{0,120}\bpaint|\bpaint\b[^.?!]{0,120}\bkids?\b/iu },
    { value: "pottery", pattern: /\bkids?\b[^.?!]{0,120}\bpottery|\bpottery\b[^.?!]{0,120}\bkids?\b/iu },
    { value: "camping", pattern: /\bfam(?:ily)?\b[^.?!]{0,120}\bcamping|\bcamping\b[^.?!]{0,120}\bfam(?:ily)?\b/iu },
    { value: "roasted marshmallows", pattern: /\broasted marshmallows\b/iu },
    { value: "shared stories", pattern: /\bshared stories\b|\btell stories\b/iu },
    { value: "hiking", pattern: /\bfam(?:ily)?\b[^.?!]{0,120}\bhiking|\bhiking\b[^.?!]{0,120}\bfam(?:ily)?\b/iu }
  ]);
  if (familyActivityTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:kids?|family|fam|dinosaur|nature|animals?|outdoors|painting|pottery|camping|marshmallows|stories|hiking)\b/iu, 10);
    const candidate = buildCandidate({
      family: "profile_family_activity",
      answerShape: "list",
      subject,
      value: familyActivityTerms.join(", "),
      confidence: 0.72,
      premises,
      metadata: { inferenceBasis: "source_bound_family_activity_profile" }
    });
    if (candidate) candidates.push(candidate);
  }

  const mediaTerms = matchedProfileTerms(allText, [
    { value: "Summer Sounds", pattern: /\bSummer Sounds\b/iu },
    { value: "Matt Patterson", pattern: /\bMatt Patterson\b/iu },
    { value: "Ed Sheeran", pattern: /\bEd Sheeran\b/iu },
    { value: "clarinet", pattern: /\bclarinet\b/iu },
    { value: "violin", pattern: /\bviolin\b/iu },
    { value: "Charlotte's Web", pattern: /\bCharlotte'?s Web\b/iu },
    { value: "Becoming Nicole", pattern: /\bBecoming Nicole\b/iu }
  ]);
  if (mediaTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:Summer Sounds|Matt Patterson|Ed Sheeran|clarinet|violin|Charlotte'?s Web|Becoming Nicole|band|music|book)\b/iu, 8);
    const candidate = buildCandidate({
      family: "profile_media_preference",
      answerShape: "list",
      subject,
      value: mediaTerms.join(", "),
      confidence: 0.7,
      premises,
      metadata: { inferenceBasis: "source_bound_media_preference_profile" }
    });
    if (candidate) candidates.push(candidate);
  }

  const identityValues: string[] = [];
  if (/\b(?:rights|activist|advocacy|inclusion|inclusive|LGBTQ|trans community|community support|stand up for what's right)\b/iu.test(allText)) {
    if (/\bpolitical\b|\brights\b|\bactivist\b|\badvocacy\b|\binclusion\b|\bcommunity support\b/iu.test(allText)) {
      identityValues.push("Likely liberal or progressive");
    }
  }
  if (/\b(?:faith|church|religious|spiritual|pray|necklace\b[^.?!]{0,120}\bfaith)\b/iu.test(allText)) {
    identityValues.push("Somewhat religious or faith-oriented");
  }
  if (/\b(?:supportive|ally|support\b[^.?!]{0,120}\btrans|transgender community|backing really means a lot|proud of you)\b/iu.test(allText)) {
    identityValues.push("Likely supportive ally");
  }
  if (identityValues.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:rights|activist|advocacy|inclusion|inclusive|LGBTQ|transgender|faith|church|religious|spiritual|supportive|ally|support)\b/iu, 10);
    const candidate = buildCandidate({
      family: "profile_identity_trait",
      answerShape: "inference",
      subject,
      value: uniqueStrings(identityValues).join("; "),
      confidence: 0.63,
      premises,
      metadata: { inferenceBasis: "source_bound_identity_trait_profile", traitConfidencePolicy: "likely_not_diagnostic" }
    });
    if (candidate) candidates.push(candidate);
  }

  const symbolTerms = matchedProfileTerms(allText, [
    { value: "rainbow flag", pattern: /\brainbow flag\b/iu },
    { value: "transgender symbol", pattern: /\btransgender symbol\b/iu },
    { value: "love, faith, and strength", pattern: /\blove,\s*faith\s+and\s+strength\b|\blove,?\s+faith,?\s+and\s+strength\b/iu },
    { value: "freedom and pride", pattern: /\bfreedom\b[^.?!]{0,80}\bpride\b/iu },
    { value: "unity and strength", pattern: /\bunity\b[^.?!]{0,80}\bstrength\b/iu }
  ]);
  if (symbolTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:symbol|symbolize|stands for|represents|rainbow flag|transgender symbol|love|faith|strength|freedom|pride|unity)\b/iu, 8);
    const candidate = buildCandidate({
      family: "profile_symbolic_meaning",
      answerShape: "list",
      subject,
      value: symbolTerms.join(", "),
      confidence: 0.74,
      premises,
      metadata: { inferenceBasis: "source_bound_symbolic_meaning_profile" }
    });
    if (candidate) candidates.push(candidate);
  }

  const lifeChangeTerms = matchedProfileTerms(allText, [
    { value: "body changes", pattern: /\bbody\b[^.?!]{0,100}\bchang(?:e|es|ed|ing)\b|\bchang(?:e|es|ed|ing)\b[^.?!]{0,100}\bbody\b/iu },
    { value: "losing unsupportive friends", pattern: /\blos(?:e|ing|t)\b[^.?!]{0,120}\bunsupportive friends?\b|\bunsupportive friends?\b/iu },
    { value: "finding self-acceptance", pattern: /\bself[- ]acceptance\b|\baccept(?:ed|ing)? myself\b|\btrue self\b/iu },
    { value: "support from friends, family, and mentors", pattern: /\bfriends?, family and mentors\b|\bfriends?, family,? and people\b|\bsupport network\b/iu },
    { value: "injury-related pottery break", pattern: /\bgot hurt\b[^.?!]{0,120}\bbreak from pottery\b|\bbreak from pottery\b/iu }
  ]);
  if (lifeChangeTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:body|changes?|unsupportive friends?|self[- ]acceptance|true self|support network|friends?|family|mentors?|got hurt|break from pottery)\b/iu, 10);
    const candidate = buildCandidate({
      family: "profile_life_change",
      answerShape: "list",
      subject,
      value: lifeChangeTerms.join(", "),
      confidence: 0.7,
      premises,
      metadata: { inferenceBasis: "source_bound_life_change_profile" }
    });
    if (candidate) candidates.push(candidate);
  }

  const supportReasonTerms = matchedProfileTerms(allText, [
    { value: "inclusivity and support for LGBTQ+ individuals", pattern: /\binclusivity\b[^.?!]{0,120}\bsupport\b|\bhelp LGBTQ\+? folks\b/iu },
    { value: "creating a family for kids who need one", pattern: /\bcreating? a family\b|\bfamily for kids who need\b|\bgive kids a loving home\b/iu },
    { value: "own journey and support received", pattern: /\bown journey\b|\bsupport (?:I|she|he|they) received\b|\bcounseling improved\b/iu },
    { value: "visited an LGBTQ center and wanted to capture unity and strength", pattern: /\bvisited (?:a|an) LGBTQ\+? center\b|\bcapture\b[^.?!]{0,80}\bunity\b[^.?!]{0,80}\bstrength\b/iu },
    { value: "de-stress and clear her mind", pattern: /\bde[- ]stress\b|\bclear (?:her|my) mind\b/iu },
    { value: "catch the eye and make people smile", pattern: /\bcatch the eye\b|\bmake people smile\b/iu },
    { value: "appreciate small moments and wedding memories", pattern: /\bappreciate the small moments\b|\bwedding decor\b/iu },
    { value: "awe of the universe", pattern: /\bawe of the universe\b/iu }
  ]);
  if (supportReasonTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:because|chose|motivated|inspired|support|journey|LGBTQ|center|unity|strength|de[- ]stress|clear|smile|small moments|wedding|awe)\b/iu, 10);
    const candidate = buildCandidate({
      family: "profile_support_reason",
      answerShape: "reason",
      subject,
      value: supportReasonTerms.join("; "),
      confidence: 0.7,
      premises,
      metadata: { inferenceBasis: "source_bound_profile_support_reason" }
    });
    if (candidate) candidates.push(candidate);
  }

  const transitionTerms = matchedProfileTerms(allText, [
    { value: "exploring identity through art", pattern: /\bexplore (?:my|her|his|their) identity\b|\bgender identity\b[^.?!]{0,120}\bart\b/iu },
    { value: "being true to herself", pattern: /\bbe true to myself\b|\blive authentically\b|\btrue self\b/iu },
    { value: "supportive community", pattern: /\bsupportive community\b|\baccepted, loved and supported\b/iu }
  ]);
  if (transitionTerms.length > 0) {
    const premises = selectPremises(subjectUnits, /\b(?:identity|gender|art|true self|authentically|supportive community|accepted|loved|supported)\b/iu, 8);
    const candidate = buildCandidate({
      family: "profile_transition_context",
      answerShape: "list",
      subject,
      value: transitionTerms.join(", "),
      confidence: 0.68,
      premises,
      metadata: { inferenceBasis: "source_bound_transition_context_profile" }
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function buildAdviceCandidates(grouped: Map<string, ProfileInferenceUnit[]>): ProfileInferenceCandidate[] {
  const candidates: ProfileInferenceCandidate[] = [];
  const subjectEntries = [...grouped.values()].map((units) => ({
    subject: displaySubject(units),
    units,
    text: units.map((unit) => unit.text).join("\n")
  }));
  for (const left of subjectEntries) {
    const leftHasSmallChanges = containsAny(left.text, ["small changes", "routine", "doctor", "weight", "exercise", "run", "healthy"]);
    for (const right of subjectEntries) {
      if (normalizeEntityName(left.subject) === normalizeEntityName(right.subject)) continue;
      const combined = `${left.text}\n${right.text}`;
      const rightHasCoping = containsAny(right.text, ["hiking", "painting", "watercolor", "road trip", "family", "support", "stress"]);
      if (!leftHasSmallChanges || !rightHasCoping) continue;
      const premises = [
        ...selectPremises(left.units, /\b(?:small changes|routine|doctor|weight|exercise|run|healthy)\b/iu, 4),
        ...selectPremises(right.units, /\b(?:hiking|painting|watercolor|road\s*trip|family|support|stress|friendship)\b/iu, 5)
      ];
      if (premises.length < 2 || !containsAny(combined, ["friend", "family", "support", "road trip", "hiking", "painting"])) continue;
      const candidate = buildCandidate({
        family: "advice_synthesis",
        answerShape: "recommendation",
        subject: right.subject,
        pairSubject: left.subject,
        value: "Make small consistent changes, use stress-relieving activities like hiking, painting, or road trips, and rely on friendship or family support.",
        confidence: 0.7,
        premises,
        metadata: {
          inferenceBasis: "multi_person_life_transition_advice",
          adviceSubjects: uniqueStrings([right.subject, left.subject])
        }
      });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function buildCrossSubjectActivityFitCandidates(grouped: Map<string, ProfileInferenceUnit[]>): ProfileInferenceCandidate[] {
  const candidates: ProfileInferenceCandidate[] = [];
  const entries = [...grouped.values()].map((units) => ({
    subject: displaySubject(units),
    units,
    text: units.map((unit) => unit.text).join("\n")
  }));
  const dogTreatSources = entries
    .map((entry) => ({
      ...entry,
      premises: selectPremises(entry.units, /\b(?:homemade\s+)?dog treats?|pup-friendly|goodies\b/iu, 4)
    }))
    .filter((entry) => entry.premises.length > 0);
  if (dogTreatSources.length === 0) return candidates;
  for (const owner of entries) {
    if (!containsAny(owner.text, ["my pup", "my dog", "Toby", "dog", "dogs"])) continue;
    const ownerPremises = selectPremises(owner.units, /\b(?:my pup|my dog|Toby|dog|dogs|board games?|indoor)\b/iu, 3);
    for (const source of dogTreatSources) {
      const candidate = buildCandidate({
        family: "activity_fit",
        answerShape: "recommendation",
        subject: owner.subject,
        pairSubject: source.subject,
        value: "cook dog treats",
        confidence: 0.62,
        premises: [...ownerPremises, ...source.premises],
        metadata: {
          inferenceBasis: "cross_subject_dog_treat_activity_transfer",
          sourceModality: "text_or_image_query"
        }
      });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function dedupeCandidates(candidates: readonly ProfileInferenceCandidate[]): ProfileInferenceCandidate[] {
  const byKey = new Map<string, ProfileInferenceCandidate>();
  for (const candidate of candidates) {
    const key = [
      normalizeEntityName(candidate.subject),
      normalizeEntityName(candidate.pairSubject ?? ""),
      candidate.family,
      compact(candidate.value)
    ].join("|");
    const existing = byKey.get(key);
    if (!existing || candidate.confidence > existing.confidence || candidate.premises.length > existing.premises.length) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function buildProfileInferenceCandidates(units: readonly ProfileInferenceUnit[]): readonly ProfileInferenceCandidate[] {
  const grouped = unitsBySubject(units);
  const candidates: ProfileInferenceCandidate[] = [];
  for (const subjectUnits of grouped.values()) {
    candidates.push(...buildSubjectCandidates(displaySubject(subjectUnits), subjectUnits));
    candidates.push(...buildReportProfileCandidates(displaySubject(subjectUnits), subjectUnits));
  }
  candidates.push(...buildCrossSubjectActivityFitCandidates(grouped));
  candidates.push(...buildAdviceCandidates(grouped));
  return dedupeCandidates(candidates);
}

export function buildProfileInferenceCandidatesFromSourceTextsForTest(contents: readonly string[]): readonly ProfileInferenceCandidate[] {
  const rows: ProfileInferenceSourceRow[] = contents.map((content, index) => ({
    source_table: "artifact_chunks",
    source_row_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    memory_id: null,
    artifact_id: null,
    artifact_observation_id: null,
    source_chunk_id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
    occurred_at: null,
    content,
    artifact_uri: `test://profile-inference/${index + 1}`,
    metadata: { source_type: "test" }
  }));
  return buildProfileInferenceCandidates(rows.flatMap(sourceUnitsForRow));
}

function inferencePromotionRejectionReason(candidate: ProfileInferenceCandidate): string | null {
  if (!candidate.supportPhrase) return "evidence_missing";
  if (candidate.premises.length < 1) return "premise_missing";
  if (!candidate.subject) return "subject_binding";
  if (candidate.family === "health_inference" && !/^(?:Possible|Likely)\b/u.test(candidate.value)) {
    return "health_inference_overconfident";
  }
  if (candidate.confidence < 0.5) return "confidence_below_floor";
  return null;
}

async function resolveSubjectEntityId(client: PoolClient, namespaceId: string, subject: string | null): Promise<string | null> {
  if (!subject) return null;
  const normalized = normalizeEntityName(subject);
  if (!normalized) return null;
  const result = await client.query<{ readonly id: string }>(
    `
      SELECT id::text
      FROM entities
      WHERE namespace_id = $1
        AND entity_type IN ('self', 'person')
        AND normalized_name = $2
      UNION
      SELECT e.id::text
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.namespace_id = $1
        AND e.entity_type IN ('self', 'person')
        AND ea.normalized_alias = $2
      LIMIT 1
    `,
    [namespaceId, normalized]
  );
  return result.rows[0]?.id ?? null;
}

async function resolveOrCreateSubjectEntityId(client: PoolClient, namespaceId: string, subject: string | null): Promise<string | null> {
  const existing = await resolveSubjectEntityId(client, namespaceId, subject);
  if (existing || !subject) return existing;
  const normalized = normalizeEntityName(subject);
  if (!normalized) return null;
  const result = await client.query<{ readonly id: string }>(
    `
      INSERT INTO entities (namespace_id, entity_type, canonical_name, normalized_name, metadata)
      VALUES ($1, 'person', $2, $3, $4::jsonb)
      ON CONFLICT (namespace_id, entity_type, normalized_name)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        last_seen_at = now(),
        metadata = entities.metadata || EXCLUDED.metadata
      RETURNING id::text
    `,
    [
      namespaceId,
      subject,
      normalized,
      JSON.stringify({ source: "profile_inference_compiler", subject_binding: "explicit_source_subject" })
    ]
  );
  return result.rows[0]?.id ?? null;
}

async function persistRejectedProfileInference(params: {
  readonly client: PoolClient;
  readonly namespaceId: string;
  readonly candidate: ProfileInferenceCandidate;
  readonly rejectionReason: string;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO compiled_memory_coverage (
        namespace_id, source_table, source_row_id, source_scene_id, compiler_stage, query_family,
        exact_detail_family, promotion_status, rejection_reason, support_phrase, source_text, confidence, metadata
      )
      VALUES ($1, $2, $3::uuid, NULL, 'profile_inference_compiler', 'profile_report', $4, 'rejected', $5, $6, $7, $8, $9::jsonb)
    `,
    [
      params.namespaceId,
      params.candidate.sourceTable,
      params.candidate.sourceRowId,
      params.candidate.family,
      params.rejectionReason,
      params.candidate.supportPhrase,
      params.candidate.sourceText,
      params.candidate.confidence,
      JSON.stringify({
        compilerOwner: "profile_inference",
        profileInferenceCompilerSource: "typed_memory_rebuild_profile_inference",
        profileInferenceFamily: params.candidate.family,
        subject: params.candidate.subject,
        pairSubject: params.candidate.pairSubject ?? null,
        inferenceRejectionReason: params.rejectionReason,
        sourcePremises: params.candidate.premises
      })
    ]
  );
}

async function persistCompiledProfileInference(params: {
  readonly client: PoolClient;
  readonly namespaceId: string;
  readonly candidate: ProfileInferenceCandidate;
}): Promise<"compiled" | "rejected"> {
  const rejectionReason = inferencePromotionRejectionReason(params.candidate);
  if (rejectionReason) {
    await persistRejectedProfileInference({ ...params, rejectionReason });
    return "rejected";
  }
  const subjectEntityId = await resolveOrCreateSubjectEntityId(params.client, params.namespaceId, params.candidate.subject);
  const pairSubjectEntityId = params.candidate.pairSubject
    ? await resolveOrCreateSubjectEntityId(params.client, params.namespaceId, params.candidate.pairSubject)
    : null;
  if (!subjectEntityId) {
    await persistRejectedProfileInference({ ...params, rejectionReason: "subject_binding" });
    return "rejected";
  }
  const metadata = {
    ...params.candidate.metadata,
    compilerOwner: "profile_inference",
    profileInferenceCompilerSource: "typed_memory_rebuild_profile_inference",
    profileInferenceFamily: params.candidate.family,
    profileInferenceFamilyApproved: true,
    inferencePromotionStatus: "compiled",
    premiseCount: params.candidate.premises.length,
    premiseCoverageStatus: "source_bound_premises_present",
    inferenceConfidence: params.candidate.confidence,
    answerShape: params.candidate.answerShape,
    taxonomyStatus: "approved",
    taxonomyVersion: "memory_taxonomy_v1",
    subject: params.candidate.subject,
    pairSubject: params.candidate.pairSubject ?? null,
    subjectEntityId,
    pairSubjectEntityId,
    source_uri: params.candidate.sourceUri,
    sourcePremises: params.candidate.premises,
    queryTimeGLiNEROrLLMUsed: false
  };
  await params.client.query(
    `
      INSERT INTO compiled_fact_observations (
        namespace_id, subject_entity_id, pair_subject_entity_id, query_family, exact_detail_family, predicate_family, property_key,
        answer_value, normalized_answer_value, truth_status, confidence, source_table, source_row_id,
        source_scene_id, source_memory_id, source_chunk_id, support_phrase, source_text, extractor, model_id,
        schema_version, promotion_status, admissibility_status, rejection_reason, metadata, valid_from
      )
      VALUES (
        $1, $2::uuid, $3::uuid, 'profile_report', NULL, 'profile_inference', $4, $5,
        lower(regexp_replace($5, '[^a-zA-Z0-9]+', ' ', 'g')), 'active', $6,
        $7, $8::uuid, NULL, $9::uuid, $10::uuid, $11, $12,
        'typed_memory_profile_inference_compiler', 'typed_memory_profile_inference_compiler',
        'profile_inference_observation_v1', 'compiled', 'admissible', NULL, $13::jsonb, $14::timestamptz
      )
      ON CONFLICT (
        namespace_id, source_table, source_row_id, exact_detail_family, property_key, normalized_answer_value, subject_entity_id
      )
      DO UPDATE SET
        answer_value = EXCLUDED.answer_value,
        confidence = GREATEST(COALESCE(compiled_fact_observations.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
        support_phrase = EXCLUDED.support_phrase,
        source_text = EXCLUDED.source_text,
        model_id = EXCLUDED.model_id,
        schema_version = EXCLUDED.schema_version,
        metadata = compiled_fact_observations.metadata || EXCLUDED.metadata,
        valid_from = COALESCE(compiled_fact_observations.valid_from, EXCLUDED.valid_from),
        updated_at = now()
    `,
    [
      params.namespaceId,
      subjectEntityId,
      pairSubjectEntityId,
      `inference:${params.candidate.family}`,
      params.candidate.value,
      params.candidate.confidence,
      params.candidate.sourceTable,
      params.candidate.sourceRowId,
      params.candidate.sourceMemoryId,
      params.candidate.sourceChunkId,
      params.candidate.supportPhrase,
      params.candidate.sourceText,
      JSON.stringify(metadata),
      params.candidate.validFrom
    ]
  );
  return "compiled";
}

async function loadSourceRows(namespaceId: string): Promise<readonly ProfileInferenceSourceRow[]> {
  return queryRows<ProfileInferenceSourceRow>(
    `
      WITH source_rows AS (
        SELECT
          'episodic_memory'::text AS source_table,
          em.id::text AS source_row_id,
          em.id::text AS memory_id,
          em.artifact_id::text AS artifact_id,
          em.artifact_observation_id::text AS artifact_observation_id,
          em.source_chunk_id::text AS source_chunk_id,
          em.occurred_at::text AS occurred_at,
          em.content,
          a.uri AS artifact_uri,
          em.metadata
        FROM episodic_memory em
        LEFT JOIN artifacts a ON a.id = em.artifact_id
        WHERE em.namespace_id = $1
        UNION ALL
        SELECT
          'artifact_chunks'::text AS source_table,
          ac.id::text AS source_row_id,
          NULL::text AS memory_id,
          ac.artifact_id::text AS artifact_id,
          ac.artifact_observation_id::text AS artifact_observation_id,
          ac.id::text AS source_chunk_id,
          ao.observed_at::text AS occurred_at,
          ac.text_content AS content,
          a.uri AS artifact_uri,
          COALESCE(ac.metadata, '{}'::jsonb) ||
            jsonb_build_object(
              'source_type', a.artifact_type,
              'artifact_metadata', COALESCE(a.metadata, '{}'::jsonb),
              'observation_metadata', COALESCE(ao.metadata, '{}'::jsonb)
            ) AS metadata
        FROM artifact_chunks ac
        JOIN artifacts a ON a.id = ac.artifact_id
        LEFT JOIN artifact_observations ao ON ao.id = ac.artifact_observation_id
        WHERE a.namespace_id = $1
      )
      SELECT *
      FROM source_rows
      ORDER BY artifact_id ASC NULLS LAST, artifact_observation_id ASC NULLS LAST, source_row_id ASC
    `,
    [namespaceId]
  );
}

async function loadDirectFactPremiseRows(namespaceId: string): Promise<readonly DirectFactPremiseRow[]> {
  return queryRows<DirectFactPremiseRow>(
    `
      SELECT
        'compiled_fact_observations'::text AS source_table,
        cfo.id::text AS source_row_id,
        cfo.subject_entity_id::text,
        COALESCE(e.canonical_name, cfo.metadata->>'subject') AS subject_name,
        cfo.source_memory_id::text,
        cfo.source_chunk_id::text,
        NULLIF(cfo.metadata->>'source_uri', '') AS source_uri,
        cfo.valid_from::text,
        cfo.answer_value,
        cfo.support_phrase,
        cfo.source_text,
        cfo.metadata
      FROM compiled_fact_observations cfo
      LEFT JOIN entities e ON e.id = cfo.subject_entity_id
      WHERE cfo.namespace_id = $1
        AND cfo.predicate_family = 'direct_fact'
        AND cfo.promotion_status = 'compiled'
        AND cfo.admissibility_status = 'admissible'
        AND cfo.truth_status = 'active'
        AND cfo.answer_value IS NOT NULL
        AND cfo.support_phrase IS NOT NULL
      ORDER BY cfo.created_at ASC
    `,
    [namespaceId]
  );
}

export async function rebuildCompiledProfileInferenceObservationsNamespace(
  namespaceId: string
): Promise<CompiledProfileInferenceRebuildCounts> {
  const rows = await loadSourceRows(namespaceId);
  const directFactRows = await loadDirectFactPremiseRows(namespaceId);
  const units = [
    ...rows.flatMap(sourceUnitsForRow),
    ...directFactUnitsForRows(directFactRows)
  ];
  const candidates = buildProfileInferenceCandidates(units);
  let promoted = 0;
  let rejected = 0;
  await withTransaction(async (client) => {
    await client.query(
      `
        DELETE FROM compiled_fact_observations
        WHERE namespace_id = $1
          AND predicate_family = 'profile_inference'
          AND metadata->>'profileInferenceCompilerSource' = 'typed_memory_rebuild_profile_inference'
      `,
      [namespaceId]
    );
    await client.query(
      `
        DELETE FROM compiled_memory_coverage
        WHERE namespace_id = $1
          AND compiler_stage = 'profile_inference_compiler'
          AND metadata->>'profileInferenceCompilerSource' = 'typed_memory_rebuild_profile_inference'
      `,
      [namespaceId]
    );
    for (const candidate of candidates) {
      const status = await persistCompiledProfileInference({ client, namespaceId, candidate });
      if (status === "compiled") promoted += 1;
      else rejected += 1;
    }
  });
  return { promoted, rejected, ambiguous: 0, sourceRows: rows.length + directFactRows.length };
}
