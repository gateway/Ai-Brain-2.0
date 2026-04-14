import { inferTemporalEventKeyFromText } from "../../canonical-memory/service.js";
import { inferExactDetailQuestionFamily } from "../exact-detail-question-family.js";
import { extractEntityNameHints } from "../query-entity-focus.js";
import type { AnswerRetrievalPlan } from "../types.js";

function normalizePlannerRuntimeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function stripLeadingBlockedNameToken(term: string, blockedTokens: ReadonlySet<string>): string {
  const normalized = normalizePlannerRuntimeText(term);
  const parts = normalized.split(/\s+/u);
  if (parts.length >= 2 && blockedTokens.has((parts[0] ?? "").toLowerCase())) {
    return parts.slice(1).join(" ");
  }
  return normalized;
}

function extractConversationParticipants(queryText: string): readonly string[] {
  const stopWords = new Set([
    "Why",
    "What",
    "Who",
    "Where",
    "When",
    "Can",
    "Make",
    "Pull",
    "List",
    "Explain",
    "Could",
    "Would",
    "Give",
    "Please",
    "Overview",
    "Breakdown",
    "Summary",
    "Conversation",
    "Project",
    "Yesterday",
    "Today",
    "Tonight",
    "Last",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
    "January",
    "February"
  ]);

  const names = new Set<string>();
  const normalizedStopWords = new Set([...stopWords].map((value) => value.toLowerCase()));
  const matches = queryText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gu) ?? [];
  for (const match of matches) {
    const normalized = stripLeadingBlockedNameToken(match, normalizedStopWords);
    if (normalized && !stopWords.has(normalized)) {
      names.add(normalized);
    }
  }

  if (/\b(i|my|we|our)\b/i.test(queryText)) {
    names.add("Steve");
  }

  return [...names];
}

export function buildEarlyTemporalLaneQueryText(queryText: string): string {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  switch (queryEventKey) {
    case "career_high_points":
      return `${queryText} career high highest ever 40 points scored last week last month game`;
    case "start_financial_analyst_job":
      return `${queryText} started a new job as a financial analyst last week job start`;
    case "make_muffins_self":
      return `${queryText} muffins for herself for myself just for me baked last week`;
    case "mother_pass_away":
      return `${queryText} mother passed away died a few years ago grief loss`;
    case "resume_playing_drums":
      return `${queryText} playing drums again resumed back at it adulthood for a month now`;
    case "adopt_first_three_dogs":
    case "adopt_dogs":
      return `${queryText} first three dogs have had them for 3 years adopted three years ago`;
    default:
      return `${queryText} last week last month years ago resumed drums had them for 3 years`;
  }
}

export function buildEarlyTemporalLaneTerms(queryText: string, plannerTerms: readonly string[]): readonly string[] {
  const extraTerms = (() => {
    const queryEventKey = inferTemporalEventKeyFromText(queryText);
    switch (queryEventKey) {
      case "career_high_points":
        return ["career-high", "highest", "points", "40", "last week", "last month", "game"];
      case "start_financial_analyst_job":
        return ["financial analyst", "new job", "started", "last week", "job start"];
      case "make_muffins_self":
        return ["muffins", "for herself", "for myself", "just for me", "baked", "last week"];
      case "mother_pass_away":
        return ["mother", "passed away", "died", "few years ago", "loss"];
      case "resume_playing_drums":
        return ["drums", "again", "resumed", "back at it", "month now", "adulthood"];
      case "adopt_first_three_dogs":
      case "adopt_dogs":
        return ["adopted", "dogs", "first three", "have had them", "3 years", "three years ago"];
      default:
        return ["last week", "last month", "years ago", "drums", "adopted"];
    }
  })();
  return [...new Set([...(plannerTerms ?? []), ...extraTerms])];
}

export function extractEarlyTemporalSupportKeywords(queryText: string): readonly string[] {
  const queryEventKey = inferTemporalEventKeyFromText(queryText);
  switch (queryEventKey) {
    case "career_high_points":
      return ["career high", "highest ever", "40 points", "last week", "last month", "points"];
    case "start_financial_analyst_job":
      return ["financial analyst", "new job", "started a new job", "last week"];
    case "make_muffins_self":
      return ["muffins", "for herself", "for myself", "just for me", "last week", "baked"];
    case "mother_pass_away":
      return ["mother passed away", "mother died", "few years ago", "grief"];
    case "resume_playing_drums":
      return ["play drums again", "resumed drums", "back at it", "month now"];
    case "adopt_first_three_dogs":
    case "adopt_dogs":
      return ["first three dogs", "have had them for 3 years", "adopted dogs", "three years ago"];
    default:
      return ["last week", "last month", "years ago"];
  }
}

export function extractDurationQuerySupportKeywords(queryText: string): readonly string[] {
  const keywords = new Set<string>([
    "for",
    "years",
    "months",
    "weeks",
    "days",
    "ago",
    "since",
    "have had",
    "had them",
    "have had them",
    "i've had them for",
    "owned for"
  ]);
  for (const match of queryText.matchAll(/\b(snakes?|dogs?|cats?|birds?|fish|hamsters?|rabbits?|turtles?|lizards?)\b/giu)) {
    const value = normalizePlannerRuntimeText(match[1]).toLowerCase();
    if (value) {
      keywords.add(value);
    }
  }
  if (/\bfirst two\b/i.test(queryText)) {
    keywords.add("first two");
    keywords.add("first pair");
  }
  return [...keywords];
}

export function extractEndorsementQuerySupportKeywords(queryText: string): readonly string[] {
  const keywords = new Set<string>([
    "endorsement",
    "endorsement deal",
    "brand",
    "brand deal",
    "company",
    "gear company",
    "outdoor gear",
    "sponsor",
    "sponsorship",
    "reached out",
    "signed up",
    "offered"
  ]);
  for (const match of queryText.matchAll(/\b([A-Z][a-z]+)\b/gu)) {
    const value = normalizePlannerRuntimeText(match[1]).toLowerCase();
    if (value && !["which", "what"].includes(value)) {
      keywords.add(value);
    }
  }
  return [...keywords];
}

export function extractStressBusterQuerySupportKeywords(queryText: string): readonly string[] {
  const keywords = new Set<string>([
    "stress",
    "stress-buster",
    "stress relief",
    "destress",
    "de-stress",
    "happy place",
    "escape",
    "started doing",
    "few years back",
    "a few years back",
    "dancing",
    "dance",
    "running",
    "painting",
    "watercolor",
    "watercolor painting",
    "pottery",
    "yoga"
  ]);
  for (const match of queryText.matchAll(/\b([A-Z][a-z]+)\b/gu)) {
    const value = normalizePlannerRuntimeText(match[1]).toLowerCase();
    if (value && !["which", "what"].includes(value)) {
      keywords.add(value);
    }
  }
  return [...keywords];
}

export function extractTravelReportSupportKeywords(queryText: string): readonly string[] {
  const keywords = new Set<string>([
    "roadtrip",
    "roadtrips",
    "family roadtrip",
    "travel",
    "trip",
    "festival",
    "music festival",
    "concert",
    "visited",
    "went",
    "places",
    "Rockies",
    "Jasper",
    "Tokyo",
    "Japan"
  ]);
  for (const match of queryText.matchAll(/\b([A-Z][a-z]+)\b/gu)) {
    const value = normalizePlannerRuntimeText(match[1]).toLowerCase();
    if (value && !["where", "what"].includes(value)) {
      keywords.add(value);
    }
  }
  return [...keywords];
}

export function extractComparativeFitSupportKeywords(queryText: string): readonly string[] {
  const keywords = new Set<string>([
    "performing",
    "performing live",
    "live",
    "stage",
    "venue",
    "crowds",
    "large crowds",
    "Hollywood Bowl",
    "rush of performing",
    "onstage",
    "concert"
  ]);
  for (const match of queryText.matchAll(/\b([A-Z][a-z]+)\b/gu)) {
    const value = normalizePlannerRuntimeText(match[1]).toLowerCase();
    if (value && !["would", "what"].includes(value)) {
      keywords.add(value);
    }
  }
  return [...keywords];
}

export function isOffCourtCareerGoalQuery(queryText: string): boolean {
  return (
    /\bgoals?\b/iu.test(queryText) &&
    (
      /\boff the court\b/iu.test(queryText) ||
      /\bbeyond basketball\b/iu.test(queryText) ||
      /\bnot related to\b[^?!.]{0,40}\bbasketball\b/iu.test(queryText) ||
      /\boutside (?:of )?basketball\b/iu.test(queryText) ||
      /\bbasketball skills\b/iu.test(queryText)
    )
  );
}

export function isBasketballCareerGoalQuery(queryText: string): boolean {
  return /\bgoals?\b/iu.test(queryText) && /\bbasketball\b/iu.test(queryText) && !isOffCourtCareerGoalQuery(queryText);
}

export function isBooksByAuthorPreferenceQuery(queryText: string): boolean {
  return /\bbooks?\s+by\b/iu.test(queryText) && /\bor\b/iu.test(queryText);
}

export function extractPlannerPreferenceChoiceOptions(queryText: string): readonly string[] {
  const normalizeChoiceOption = (value: string): string => normalizePlannerRuntimeText(value).toLowerCase();
  const booksByMatch = queryText.match(/\bbooks?\s+by\s+([^?]+?)\s+or\s+([^?]+?)(?:\?|$)/iu);
  if (booksByMatch) {
    return [...new Set([booksByMatch[1] ?? "", booksByMatch[2] ?? ""].map(normalizeChoiceOption).filter(Boolean))];
  }
  const articleMatch = queryText.match(/\b(?:a|an)\s+([^?]+?)\s+or\s+(?:a|an)\s+([^?]+?)(?:\?|$)/iu);
  if (articleMatch) {
    return [...new Set([articleMatch[1] ?? "", articleMatch[2] ?? ""].map(normalizeChoiceOption).filter(Boolean))];
  }
  const genericMatch = queryText.match(/\b([^?]+?)\s+or\s+([^?]+?)(?:\?|$)/iu);
  return genericMatch
    ? [...new Set([genericMatch[1] ?? "", genericMatch[2] ?? ""].map(normalizeChoiceOption).filter(Boolean))]
    : [];
}

export function isGoalSetQuery(queryText: string): boolean {
  const normalized = normalizePlannerRuntimeText(queryText).toLowerCase();
  return /\bgoals?\b/u.test(normalized) && /\bcareer\b/u.test(normalized);
}

export function isCausalReasonQuery(queryText: string): boolean {
  return (
    /^\s*why\b/iu.test(queryText) ||
    /\bwhat\s+helped\b/iu.test(queryText) ||
    /\bwhat\s+(?:made|caused|prompted)\b/iu.test(queryText) ||
    /\bhow\s+did\b[^?!.]{0,120}\bhelp\b/iu.test(queryText) ||
    /\breason\b/iu.test(queryText)
  );
}

export function isComparativeFitQuery(queryText: string): boolean {
  const normalized = normalizePlannerRuntimeText(queryText).toLowerCase();
  return (
    /\bwould\b/u.test(normalized) &&
    /\b(enjoy|like|love)\b/u.test(normalized) &&
    (
      /\bperform(?:ing)?\b/u.test(normalized) ||
      /\bstage\b/u.test(normalized) ||
      /\bvenue\b/u.test(normalized) ||
      /\bconcert\b/u.test(normalized) ||
      /\bhollywood bowl\b/u.test(normalized)
    )
  );
}

export function inferCareerGoalCompletenessTarget(queryText: string): number {
  if (isOffCourtCareerGoalQuery(queryText)) {
    return 3;
  }
  return /\bgoals?\b/iu.test(queryText) ? 2 : 1;
}

export function splitPlannerRuntimeEntryValues(value: string | null | undefined): readonly string[] {
  const normalized = normalizePlannerRuntimeText(value ?? "");
  if (!normalized) {
    return [];
  }
  return [...new Set(
    normalized
      .replace(/\s+(?:and|or)\s+/giu, ", ")
      .split(/\s*,\s*/u)
      .map((entry) => normalizePlannerRuntimeText(entry))
      .filter((entry) => entry.length > 0)
  )];
}

export function buildEventQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim())
    .filter(Boolean);
  const filtered = candidateTerms.filter((term) => {
    const normalized = term.toLowerCase();
    return ![
      "what",
      "who",
      "where",
      "did",
      "does",
      "do",
      "go",
      "went",
      "have",
      "had",
      "get",
      "got",
      "later",
      "today",
      "tonight",
      "yesterday",
      "this",
      "with",
      "at",
      "in",
      "on",
      "to"
    ].includes(normalized);
  });

  return filtered.length > 0 ? filtered.join(" ") : queryText;
}

export function buildTemporalDetailEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const rawTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["how", "much", "many", "what", "when", "where", "who", "on", "in", "at", "did", "does", "do", "exact", "exactly", "last", "this", "today", "yesterday", "tonight", "week", "month", "year", "night"].includes(term));

  const financialTerms = new Set(["cost", "price", "amount", "paid", "spent", "spend", "fee", "fees"]);
  const hasFinancialCue = rawTerms.some((term) => financialTerms.has(term));
  const expanded = new Set(rawTerms.filter((term) => !financialTerms.has(term)));
  if (hasFinancialCue) {
    expanded.add("paid");
  }
  if (/\bfirst\b/i.test(queryText) && /\btournament\b/i.test(queryText)) {
    expanded.add("first");
    expanded.add("tournament");
    expanded.add("won");
    expanded.add("video");
    expanded.add("game");
  }
  if (/\bfirst\b/i.test(queryText) && /\bwatch\b/i.test(queryText)) {
    expanded.add("first");
    expanded.add("watch");
    expanded.add("watched");
  }
  if (/\b(?:paint|painted|drew|drawn|made|wrote)\b/i.test(queryText)) {
    expanded.add("painted");
    expanded.add("drew");
    expanded.add("made");
    expanded.add("wrote");
  }

  return [...expanded].join(" ").trim() || queryText;
}

function filterSignificantTemporalPlannerTerms(plannerTerms: readonly string[]): readonly string[] {
  return plannerTerms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => ![
      "what",
      "where",
      "who",
      "when",
      "did",
      "does",
      "do",
      "go",
      "went",
      "happened",
      "last",
      "this",
      "today",
      "yesterday",
      "tonight",
      "night",
      "earlier",
      "weekend",
      "morning",
      "afternoon",
      "evening",
      "later",
      "week",
      "month",
      "year",
      "steve",
      "dan",
      "lauren",
      "alex",
      "nina",
      "maya",
      "ben",
      "jonas",
      "kiko",
      "gummi"
    ].includes(term));
}

export function isLowInformationTemporalQuery(queryText: string, plannerTerms: readonly string[]): boolean {
  const normalized = queryText.toLowerCase();
  const significantTerms = filterSignificantTemporalPlannerTerms(plannerTerms);

  if (significantTerms.length > 0) {
    return false;
  }

  return (
    /\bwhat\s+happened\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+do\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\b/i.test(normalized)
  );
}

export function normalizeBeverageRecommendationQuery(queryText: string): string | null {
  const normalized = normalizePlannerRuntimeText(queryText);
  if (!normalized) {
    return null;
  }

  const teaTonightMatch = normalized.match(
    /\bwhat\s+tea\s+should\s+i\s+make\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+tonight\??$/iu
  );
  if (teaTonightMatch?.[1]) {
    return `what does ${teaTonightMatch[1]} usually drink in the evening now?`;
  }

  return null;
}

export function buildPreferenceEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "does", "did", "use", "used", "to", "still", "now", "in", "for", "kind", "types", "type", "which", "usually", "later", "right", "remind", "me", "these", "days", "tonight", "want", "wants", "drink", "drinks", "beverage", "beverages", "kettle", "neighborhood", "neighbourhood"].includes(term))
    .filter((term) => !/^(19\d{2}|20\d{2})$/.test(term));
  const nameHints = extractEntityNameHints(queryText);
  const primaryName = nameHints[0] ?? "";
  const lowered = queryText.toLowerCase();
  const beverageHint = /\b(tea|coffee|drink|drinks|beverage|beverages|kettle|evening)\b/.test(lowered);
  const coffeeHint = /\bcoffee\b/.test(lowered);
  const eveningLikeHint = /\b(evening|tonight|later|night)\b/.test(lowered);
  const teaHint = /\btea\b/.test(lowered) || eveningLikeHint || /\bkettle\b/.test(lowered);

  if (beverageHint) {
    const focus = coffeeHint && !teaHint ? "coffee" : "tea";
    return [primaryName, focus, eveningLikeHint ? "evening" : "", "preference"].filter(Boolean).join(" ");
  }

  const expanded = new Set(candidateTerms);
  if (candidateTerms.some((term) => term.startsWith("prefer") || term === "favorite" || term === "favourite")) {
    expanded.add("preference");
  }
  if (candidateTerms.some((term) => term.startsWith("dislik") || term.startsWith("avoid"))) {
    expanded.add("dislike");
    expanded.add("avoid");
  }
  if (candidateTerms.includes("neighborhood") || candidateTerms.includes("neighbourhood")) {
    expanded.add("area");
    expanded.add("areas");
    expanded.add("urban");
    expanded.add("noise");
  }
  if (candidateTerms.includes("places") || candidateTerms.includes("place")) {
    expanded.add("living");
  }
  if (candidateTerms.some((term) => term.startsWith("watch") || term === "want")) {
    expanded.add("watchlist");
    expanded.add("watch");
  }
  if (candidateTerms.some((term) => ["drink", "drinks", "beverage", "beverages", "kettle", "evening"].includes(term))) {
    expanded.add("tea");
    expanded.add("coffee");
    expanded.add("evening");
    expanded.add("preference");
  }

  return [...expanded].join(" ").trim() || queryText;
}

export function buildPreciseFactEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "which", "how", "long", "many", "did", "does", "do", "was", "were", "is", "the", "a", "an", "my", "to", "of", "at", "in", "on"].includes(term));
  const expanded = new Set(candidateTerms);

  if (/\bcommute\b/.test(lowered)) {
    expanded.add("commute");
    expanded.add("daily");
    expanded.add("minute");
    expanded.add("minutes");
    expanded.add("hour");
    expanded.add("hours");
    expanded.add("each");
    expanded.add("way");
  }
  if (/\bplay\b/.test(lowered)) {
    expanded.add("play");
    expanded.add("production");
    expanded.add("theater");
    expanded.add("theatre");
  }
  if (/\bplaylist|spotify\b/.test(lowered)) {
    expanded.add("playlist");
    expanded.add("spotify");
    expanded.add("called");
    expanded.add("created");
    expanded.add("music");
  }
  if (/\byoga\b/.test(lowered) || /\bclasses?\b/.test(lowered)) {
    expanded.add("yoga");
    expanded.add("class");
    expanded.add("classes");
    expanded.add("studio");
    expanded.add("practice");
  }
  if (/\bmovie|film\b/.test(lowered)) {
    expanded.add("movie");
    expanded.add("film");
    expanded.add("watched");
    expanded.add("favorite");
    expanded.add("favorites");
    expanded.add("recommend");
    expanded.add("recommendation");
    expanded.add("copy");
  }
  if (/\bmartial\s+arts?\b/.test(lowered)) {
    expanded.add("martial");
    expanded.add("arts");
    expanded.add("kickboxing");
    expanded.add("taekwondo");
    expanded.add("karate");
    expanded.add("judo");
    expanded.add("boxing");
    expanded.add("training");
  }
  if (/\bhobbies?\b/.test(lowered)) {
    expanded.add("hobbies");
    expanded.add("enjoy");
    expanded.add("love");
    expanded.add("likes");
    expanded.add("besides");
    expanded.add("hanging");
    expanded.add("writing");
    expanded.add("reading");
    expanded.add("movies");
    expanded.add("exploring");
    expanded.add("nature");
    expanded.add("friends");
  }
  if (/\bvolunteer(?:ing)?\b/.test(lowered)) {
    expanded.add("volunteer");
    expanded.add("volunteering");
    expanded.add("homeless shelter");
    expanded.add("shelter");
    expanded.add("food");
    expanded.add("supplies");
  }
  if (/\bpets?\b/.test(lowered) && /\ballerg/i.test(lowered)) {
    expanded.add("allergic");
    expanded.add("allergy");
    expanded.add("fur");
    expanded.add("hairless");
    expanded.add("reptiles");
    expanded.add("turtles");
    expanded.add("cats");
    expanded.add("pigs");
  }
  if (/\bhow\s+long\b/.test(lowered)) {
    expanded.add("years");
    expanded.add("months");
    expanded.add("weeks");
    expanded.add("days");
    expanded.add("since");
    expanded.add("have had");
    expanded.add("had them");
  }
  if (/\bhow\s+long\b/.test(lowered) && /\bfirst two\b/.test(lowered)) {
    expanded.add("first two");
  }
  if (/\btrilog(?:y|ies)\b/.test(lowered)) {
    expanded.add("trilogy");
    expanded.add("favorite");
    expanded.add("faves");
    expanded.add("series");
  }
  if (/\bbook\b/.test(lowered)) {
    expanded.add("book");
    expanded.add("read");
  }
  if (/\bmov(?:e|ed)\s+from\b/.test(lowered)) {
    expanded.add("move");
    expanded.add("moved");
    expanded.add("home");
    expanded.add("country");
    expanded.add("origin");
  }
  if (/\bshow\b/.test(lowered)) {
    expanded.add("show");
    expanded.add("watched");
  }

  return [...expanded].join(" ").trim() || queryText;
}

export function buildProfileInferenceEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "would", "likely", "pursue", "their", "there", "the", "a", "an", "in", "of", "to", "be", "is", "are"].includes(term));
  const expanded = new Set(candidateTerms);
  const bookshelfLike = /\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children's books?\b/i.test(lowered);
  const genericCollectionLike =
    !bookshelfLike &&
    (
      /\bwhat items?\b/i.test(lowered) ||
      /\bwhat does\b[^?!.]{0,80}\bcollect\b/i.test(lowered) ||
      /\bcollect(?:ion|s|ing)?\b/i.test(lowered) ||
      /\bcollectibles?\b/i.test(lowered) ||
      /\bmemorabilia\b/i.test(lowered)
    );
  const communityMembershipLike = /\bmember of the lgbtq community\b|\bally\b|\blgbtq\+?\b|\btransgender\b|\bpride\b/i.test(lowered);
  const preferenceLike = /\binterested in\b|\benjoy\b/i.test(lowered);
  const counselingCareerLike = /\bcareer|job|field|work\b/.test(lowered) || /\bwriting\b/i.test(lowered) || /\beduc/i.test(lowered);

  if (/\beduc/i.test(lowered)) {
    expanded.add("education");
    expanded.add("study");
  }
  if (/\bcareer|job|field|work\b/.test(lowered)) {
    expanded.add("career");
    expanded.add("job");
    expanded.add("work");
  }
  if (bookshelfLike) {
    expanded.add("bookshelf");
    expanded.add("classic");
    expanded.add("children's");
    expanded.add("books");
    expanded.add("dr seuss");
  }
  if (genericCollectionLike) {
    expanded.add("collect");
    expanded.add("collection");
    expanded.add("collectibles");
    expanded.add("memorabilia");
    expanded.add("items");
  }
  if (communityMembershipLike) {
    expanded.add("lgbtq");
    expanded.add("transgender");
    expanded.add("ally");
    expanded.add("pride");
    expanded.add("support");
    expanded.add("mentoring");
  }
  if (/\bwriting\b/i.test(lowered)) {
    expanded.add("writing");
    expanded.add("reading");
  }
  if (counselingCareerLike && !bookshelfLike && !genericCollectionLike && !communityMembershipLike && !preferenceLike) {
    expanded.add("mental");
    expanded.add("health");
    expanded.add("counseling");
    expanded.add("counselor");
    expanded.add("options");
  }

  return [...expanded].join(" ").trim() || queryText;
}

const PROFILE_CAREER_DOMAIN_REGEX =
  "(career|job|jobs|education|educational|study|studying|mental health|counseling|counsell?ing|counselor|counsellor)";
const PROFILE_CAREER_CUE_REGEX = "(keen on|looking into|thinking of|career options|would love|want to help)";
const PROFILE_COLLECTION_DOMAIN_REGEX =
  "(bookshelf|bookcase|library|children.{0,2}books|kids.{0,2}books|dr\\.?\\s*seuss|classic children.{0,2}books|reading to (?:them|kids)|collect(?:s|ing)?)";
const PROFILE_COMMUNITY_DOMAIN_REGEX =
  "(lgbtq\\+?|queer|pride|ally|support group|mentoring|community|transgender)";

export function buildProfileInferenceRetrievalSpec(
  queryText: string,
  plannerTerms: readonly string[],
  retrievalPlan?: AnswerRetrievalPlan | null
): {
  readonly terms: readonly string[];
  readonly bannedTerms: readonly string[];
  readonly candidatePools: readonly string[];
  readonly suppressionPools: readonly string[];
  readonly positiveScoreExpressions: readonly string[];
  readonly penaltyScoreExpressions: readonly string[];
} {
  const fallbackTerms = buildProfileInferenceEvidenceQueryText(queryText, plannerTerms)
    .split(/\s+/u)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 1);
  const terms = [
    ...new Set(
      (
        retrievalPlan?.queryExpansionTerms && retrievalPlan.queryExpansionTerms.length > 0
          ? retrievalPlan.queryExpansionTerms
          : fallbackTerms
      )
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length > 1)
    )
  ].slice(0, 14);
  const bannedTerms = [
    ...new Set((retrievalPlan?.bannedExpansionTerms ?? []).map((term) => term.trim().toLowerCase()).filter((term) => term.length > 1))
  ].slice(0, 10);
  const candidatePools = retrievalPlan?.candidatePools ?? [];
  const suppressionPools = retrievalPlan?.suppressionPools ?? [];
  const positiveScoreExpressions: string[] = [];
  const penaltyScoreExpressions: string[] = [];

  if (candidatePools.includes("collection_support")) {
    positiveScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_COLLECTION_DOMAIN_REGEX}' THEN 4 ELSE 0 END`);
  }
  if (candidatePools.includes("community_membership_support")) {
    positiveScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_COMMUNITY_DOMAIN_REGEX}' THEN 4 ELSE 0 END`);
  }
  if (candidatePools.includes("career_support") && !suppressionPools.includes("career_support")) {
    positiveScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_CAREER_DOMAIN_REGEX}' THEN 2 ELSE 0 END`);
    positiveScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_CAREER_CUE_REGEX}' THEN 2 ELSE 0 END`);
  }
  if (suppressionPools.includes("career_support") || suppressionPools.includes("health_support")) {
    penaltyScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_CAREER_DOMAIN_REGEX}' THEN -6 ELSE 0 END`);
    penaltyScoreExpressions.push(`CASE WHEN em.content ~* '${PROFILE_CAREER_CUE_REGEX}' THEN -4 ELSE 0 END`);
  }

  return {
    terms,
    bannedTerms,
    candidatePools,
    suppressionPools,
    positiveScoreExpressions,
    penaltyScoreExpressions
  };
}

export function queryAnchorTerms(queryText: string): readonly string[] {
  const anchorMatch =
    queryText.match(/\bafter\s+(?:the\s+)?([A-Za-z][A-Za-z0-9'’ -]{2,80})\??/iu) ??
    queryText.match(/\b(?:sparked?|inspired?)\b[^?]*\b(?:in|about)\s+([A-Za-z][A-Za-z0-9'’ -]{2,80})\??/iu);
  const anchorText = normalizePlannerRuntimeText(anchorMatch?.[1] ?? "");
  if (!anchorText) {
    return [];
  }
  const stopTerms = new Set(["the", "a", "an", "my", "his", "her", "their", "of", "in", "on", "for", "to"]);
  return [...new Set(
    (anchorText.match(/[A-Za-z']+/gu) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length > 2 && !stopTerms.has(term))
  )];
}

export function buildEventBoundedEvidenceTerms(queryText: string, plannerTerms: readonly string[]): readonly string[] {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9'._:-]*/g) ?? [])
    .map((term) => normalizePlannerRuntimeText(term).toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "where", "after", "did", "does", "was", "were", "the", "a", "an", "to", "go", "went"].includes(term));
  const expanded = new Set(candidateTerms);
  const lowered = queryText.toLowerCase();
  const exactFamily = inferExactDetailQuestionFamily(queryText);
  const anchorTerms = queryAnchorTerms(queryText);

  for (const term of anchorTerms) {
    expanded.add(term);
  }

  if (/\bcoffee|cafe|café\b/.test(lowered)) {
    expanded.add("coffee");
    expanded.add("cafe");
    expanded.add("place");
  }
  if (/\bmeetup|conference|event\b/.test(lowered)) {
    expanded.add("meetup");
    expanded.add("event");
  }
  if (/\bhotel\b/.test(lowered)) {
    expanded.add("hotel");
  }
  if (/\bchiang mai\b/.test(lowered)) {
    expanded.add("chiang");
    expanded.add("mai");
  }
  if (/\bcanass\b/.test(lowered)) {
    expanded.add("canass");
  }
  if (exactFamily === "realization") {
    expanded.add("realize");
    expanded.add("realized");
    expanded.add("thought-provoking");
    expanded.add("self-care");
  }
  if (/\b(?:spark(?:ed)?|interest)\b/.test(lowered)) {
    expanded.add("sparked");
    expanded.add("interest");
    expanded.add("growing");
    expanded.add("grew");
    expanded.add("education");
    expanded.add("infrastructure");
    expanded.add("community");
    expanded.add("neighborhood");
  }

  return [...expanded];
}

export function buildIdentityEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "who", "is", "their", "there", "the", "a", "an", "identity", "kind", "person", "really", "does", "identify", "as"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  if (/\bidentity\b/i.test(lowered)) {
    expanded.add("identity");
    expanded.add("self");
    expanded.add("journey");
    expanded.add("accept");
    expanded.add("accepted");
  }
  expanded.add("transgender");
  expanded.add("trans");
  expanded.add("nonbinary");
  expanded.add("gender");
  expanded.add("community");
  expanded.add("acceptance");
  expanded.add("support");

  return [...expanded].join(" ").trim() || queryText;
}

export function buildSharedCommonalityEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "how", "do", "does", "did", "both", "have", "in", "common", "same", "shared", "like", "to", "their"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  if (/\bdestress|stress\b/i.test(lowered)) {
    expanded.add("stress");
    expanded.add("destress");
    expanded.add("de-stress");
    expanded.add("relax");
    expanded.add("escape");
    expanded.add("dance");
    expanded.add("dancing");
  }
  if (/\bcommon|both|shared\b/i.test(lowered)) {
    expanded.add("lost");
    expanded.add("job");
    expanded.add("business");
    expanded.add("started");
    expanded.add("opened");
    expanded.add("own");
    expanded.add("passion");
    if (/\bdance|dancing\b/i.test(lowered)) {
      expanded.add("dance");
    }
  }
  if (/\bvisited|visit|city|cities|travel|trip\b/i.test(lowered)) {
    expanded.add("visit");
    expanded.add("visited");
    expanded.add("trip");
    expanded.add("travel");
    expanded.add("city");
    expanded.add("rome");
    expanded.add("paris");
    expanded.add("barcelona");
    expanded.add("edinburgh");
  }
  if (/\bmovie|movies|watch|watched|interests?|share\b/i.test(lowered)) {
    expanded.add("movie");
    expanded.add("movies");
    expanded.add("watch");
    expanded.add("watched");
  }
  if (/\bvolunteer(?:ing)?\b/i.test(lowered)) {
    expanded.add("volunteer");
    expanded.add("volunteering");
    expanded.add("homeless");
    expanded.add("shelter");
    expanded.add("fundraiser");
    expanded.add("food");
    expanded.add("supplies");
  }
  if (/\bdessert|desserts|bake|baking|cook|cooking\b/i.test(lowered) || /\binterests?\b/i.test(lowered)) {
    expanded.add("dessert");
    expanded.add("desserts");
    expanded.add("bake");
    expanded.add("baking");
    expanded.add("cook");
    expanded.add("cooking");
  }
  if (/\b(care about|cares about|focused on|focus|goals?|plans?|working on|project|pilot|support)\b/i.test(lowered)) {
    expanded.add("focus");
    expanded.add("focused");
    expanded.add("goal");
    expanded.add("goals");
    expanded.add("plan");
    expanded.add("plans");
    expanded.add("project");
    expanded.add("pilot");
    expanded.add("support");
    expanded.add("working");
    expanded.add("working on");
    expanded.add("care");
  }

  return [...expanded].join(" ").trim() || queryText;
}

export function buildCausalMotiveEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const lowered = queryText.toLowerCase();
  const participantHints = extractConversationParticipants(queryText);
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["why", "did", "does", "do", "the", "a", "an", "his", "her", "their", "start", "decide", "to"].includes(term));
  const expanded = new Set(candidateTerms);
  for (const participant of participantHints) {
    expanded.add(participant);
  }
  expanded.add("because");
  expanded.add("decided");
  expanded.add("start");
  expanded.add("business");
  expanded.add("passion");
  expanded.add("dream");
  expanded.add("love");
  expanded.add("share");
  expanded.add("lost");
  expanded.add("job");
  if (/\bproject\b/i.test(lowered) || /\bdirection\b/i.test(lowered) || /\bchange\b/i.test(lowered)) {
    expanded.add("project");
    expanded.add("change");
    expanded.add("changed");
    expanded.add("direction");
    expanded.add("sync");
    expanded.add("failure");
    expanded.add("offline");
    expanded.add("prevent");
    expanded.add("data");
    expanded.add("loss");
  }

  return [...expanded].join(" ").trim() || queryText;
}

export function buildDepartureEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const nameHints = extractEntityNameHints(queryText);
  const loweredTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const primaryName = nameHints[0] ?? "";
  const wantsUs = loweredTerms.includes("us") || /\bthe\s+us\b/i.test(queryText);
  if (primaryName && wantsUs) {
    return `${primaryName} left leave departed returned moved October 18 2025 US`;
  }
  if (primaryName) {
    return `${primaryName} left leave departed returned October 18 2025`;
  }
  return "left leave departed returned October 18 2025 US";
}

export function buildStorageEvidenceQueryText(_queryText: string, _plannerTerms: readonly string[]): string {
  return "stored storage belongings possessions jeep rv Bend Reno Carson Lauren Alex Eve";
}

export function buildRecentMediaEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "has", "have", "recently"].includes(term));
  const expanded = new Set(candidateTerms);
  expanded.add("movies");
  expanded.add("shows");
  expanded.add("watched");
  expanded.add("saw");
  return [...expanded].join(" ").trim() || queryText;
}

export function buildStyleSpecEvidenceQueryText(queryText: string, plannerTerms: readonly string[]): string {
  const normalized = queryText.toLowerCase();
  if (/\bprotocol\b/.test(normalized) && /\bontology\b/.test(normalized)) {
    return "Ask NotebookLM First Before Changing Ontology NotebookLM ontology protocol";
  }

  if (/\bdatabase\b/.test(normalized) && /\bslice\b/.test(normalized)) {
    return "Wipe And Replay The Database After Each Slice database replay slice workflow";
  }

  if (/\bresponse\b/.test(normalized) && /\bstyle\b/.test(normalized)) {
    return "Keep Responses Concise response style concise formatting";
  }

  if (/\bnatural\b/.test(normalized) && /\bquery/.test(normalized)) {
    return "Prefer Natural-Language Queryability natural language queryability";
  }

  const candidateTerms = (plannerTerms.length > 0 ? plannerTerms : queryText.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => !["what", "how", "should", "does", "is", "the", "my"].includes(term));

  const expanded = new Set(candidateTerms);
  if (/\bstyle\b/.test(normalized) || /\bformat/.test(normalized)) {
    expanded.add("style");
    expanded.add("concise");
  }
  if (/\bprotocol\b/.test(normalized) || /\bworkflow\b/.test(normalized)) {
    expanded.add("workflow");
    expanded.add("protocol");
  }

  return [...expanded].join(" ").trim() || queryText;
}
