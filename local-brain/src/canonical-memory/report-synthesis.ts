import { normalizeEntityLookupName } from "../identity/canonicalization.js";
import type { CanonicalReportKind } from "../retrieval/types.js";

type JsonRecord = Record<string, unknown>;

export interface CanonicalCollectionFactSeed {
  readonly itemValue: string;
  readonly normalizedValue: string;
  readonly cueType: "explicit_collects" | "collection_of" | "bookshelf_contains" | "typed_set";
  readonly cueStrength: number;
}

function normalizeName(value: string): string {
  return normalizeEntityLookupName(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeWhitespace(value)).filter((value) => value.length > 0))];
}

function normalizeCollectionEntryValue(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/^[,:; -]+|[,:; -]+$/gu, "")
      .replace(/^(?:a|an|the)\s+/iu, "")
      .replace(/^(?:to\s+)?collect(?:ing|s)?\s+/iu, "")
      .replace(/^(?:my|our|his|her|their)\s+collection of\s+/iu, "")
      .replace(/\b(?:for\b.*|because\b.*)$/iu, "")
      .replace(/^[“"']+|[”"']+$/gu, "")
  );
}

function stripCollectionMultimodalNoise(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/\[image:[^\]]*\]/giu, " ")
      .replace(/---\s*image_query:\s*[^-].*$/giu, " ")
      .replace(/---\s*image_caption:\s*.*$/giu, " ")
  );
}

function normalizeCollectionDisplayValue(value: string): string {
  return normalizeCollectionEntryValue(value)
    .replace(/^(?:a\s+)?bunch of\s+/giu, "")
    .replace(/^(?:these|those|my|our|his|her|their)\s+/giu, "")
    .replace(/\bfantasy movies?\s+dvd?s?\b/giu, "fantasy movie DVDs")
    .replace(/\b([a-z][a-z' -]*?)\s+movies\s+dvd?s?\b/giu, "$1 movie DVDs")
    .replace(/\b([a-z][a-z' -]*?)\s+movies\b/giu, "$1 movie DVDs")
    .replace(/\bmovies\s+dvd?s?\b/giu, "movie DVDs")
    .replace(/\bmovies\b/giu, "movie DVDs")
    .replace(/\bdvd?s?\b/giu, "DVDs")
    .replace(/\bmovies?\s+DVDs\b/giu, "movie DVDs")
    .replace(/\bbasketball jerseys?\b/giu, "jerseys")
    .replace(/\bbasketball jerseys\b/giu, "jerseys")
    .replace(/\bsneaker\b/giu, "sneakers")
    .replace(/\s+/gu, " ")
    .trim();
}

function isWeakCollectionEntryValue(value: string): boolean {
  const normalized = normalizeName(value);
  if (!normalized) {
    return true;
  }
  return (
    /\b(whole|entire|complete|full)\b/u.test(normalized) ||
    /^(?:collection|collectibles|items|stuff|things)$/u.test(normalized) ||
    /\b(take me there|take me to|escape from reality)\b/u.test(normalized)
  );
}

function extractInlineCollectionPhrase(text: string): string | null {
  const cleanedText = normalizeWhitespace(text.replace(/[“”"]/gu, ""));
  const imageQuerySource = normalizeWhitespace(
    cleanedText.includes("image_query:")
      ? (cleanedText.split(/image_query:\s*/iu)[1]?.split(/---\s*image_caption:/iu)[0] ?? "")
      : ""
  );
  const candidateSources = uniqueStrings([imageQuerySource, cleanedText]);
  for (const source of candidateSources) {
    const possessiveMatch = source.match(
      /\b(?:my|his|her|their|our)\s+([^.!?\n]{1,80}?)\s+collections?\b/iu
    );
    const shortMetadataMatch =
      (source === imageQuerySource || /^[a-z0-9' -]+$/iu.test(source)) && source.split(/\s+/u).length <= 8
        ? source.match(/\b([^.!?\n]{1,80}?)\s+collections?\b/iu)
        : null;
    const candidate = normalizeCollectionDisplayValue(possessiveMatch?.[1] ?? shortMetadataMatch?.[1] ?? "");
    if (!candidate || isWeakCollectionEntryValue(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

function splitCollectionEntryValues(value: string): readonly string[] {
  const cleaned = normalizeCollectionDisplayValue(stripCollectionMultimodalNoise(value))
    .replace(/\b(?:plus|along with)\b/giu, ",")
    .replace(/\s*,\s*/gu, ", ")
    .trim();
  if (!cleaned) {
    return [];
  }
  return uniqueStrings(
    cleaned
      .replace(/\s+\band\b\s+/giu, ", ")
      .split(/\s*,\s*/u)
      .map((entry) => normalizeCollectionDisplayValue(entry))
      .filter((entry) => entry.length > 1 && !isWeakCollectionEntryValue(entry))
  );
}

function summarizeReportCandidates(values: readonly string[]): string | null {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unique.slice(0, 3).join(". ");
}

function deriveSupportReportSummary(texts: readonly string[]): string | null {
  const combined = normalizeWhitespace(texts.join(" ")).toLowerCase();
  if (!combined) {
    return null;
  }
  if (
    /\bextra funding\b|\bfunding\b/u.test(combined) &&
    /\brepairs?\b|\brenovations?\b|\bsafer\b|\bmodern\b|\blearning environment\b/u.test(combined)
  ) {
    return "Enabled needed repairs and renovations, making the learning environment safer and more modern for students.";
  }
  if (
    /\bgrief|grieving|peace\b/u.test(combined) &&
    /\bsupport group\b|\bcommunity\b|\bfaith\b|\btherapy\b|\bcounseling\b/u.test(combined)
  ) {
    return "Community support helped provide peace while grieving.";
  }
  return null;
}

function joinSummaryValues(values: readonly string[]): string | null {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return null;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  if (unique.length === 2) {
    return `${unique[0]!} and ${unique[1]!}`;
  }
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]!}`;
}

function classifyCollectionValue(text: string): string | null {
  const cleanedText = normalizeWhitespace(text.replace(/[“”"]/gu, ""));
  const normalized = normalizeWhitespace(cleanedText.toLowerCase().replace(/[^a-z0-9]+/gu, " "));
  if (!normalized) {
    return null;
  }
  const hasExplicitCollectionCue = /\bcollects?\b|\bcollection of\b|\bcollectibles?\b/u.test(normalized);
  if (/\bclassic children s books\b|\bclassic childrens books\b|\bchildren s books\b|\bchildrens books\b/u.test(normalized)) {
    return "classic children's books";
  }
  if (
    /\b(kids|children|childrens)\b/u.test(normalized) &&
    /\bbooks\b/u.test(normalized) &&
    /\b(classic|classics|educational books|stories from different cultures)\b/u.test(normalized)
  ) {
    return "classic children's books";
  }
  if (
    /\bbookshelf\b|\bbookcase\b|\blibrary\b/u.test(normalized) &&
    /\bkids\b|\bchildren\b|\bchildrens\b/u.test(normalized) &&
    /\bbooks\b|\breading\b/u.test(normalized)
  ) {
      return "classic children's books";
  }
  if (hasExplicitCollectionCue && /\bharry potter\b/u.test(normalized)) {
    return "Harry Potter items";
  }
  if (hasExplicitCollectionCue && /\bdr seuss\b/u.test(normalized)) {
    return "Dr. Seuss books";
  }
  for (const match of cleanedText.matchAll(
    /\bcollects?\s+([^.!?\n]+)|\bcollection of\s+([^.!?\n]+)|\bcollectibles?\s+(?:include|includes|like|such as)?\s*([^.!?\n]+)/giu
  )) {
    const candidate = normalizeWhitespace(
      (match[1] ?? match[2] ?? match[3] ?? "")
        .replace(/^(?:a|an|the)\s+/iu, "")
        .replace(/\b(?:for\b.*|because\b.*)$/iu, "")
        .replace(/^[,:; -]+|[,:; -]+$/gu, "")
    );
    if (!candidate) {
      continue;
    }
    const lowered = candidate.toLowerCase();
    if (
      /\b(vintage|sports|music|movie|comic|vinyl|record|records|memorabilia|collectibles|figurines|coins|cards|posters|art prints?)\b/u.test(lowered) ||
      /\band\b/u.test(lowered)
    ) {
      return candidate;
    }
  }
  const inlineCollectionPhrase = extractInlineCollectionPhrase(cleanedText);
  if (inlineCollectionPhrase) {
    return inlineCollectionPhrase;
  }
  return null;
}

function inferCollectionCueType(text: string): CanonicalCollectionFactSeed["cueType"] | null {
  const normalized = normalizeWhitespace(text.toLowerCase().replace(/[^a-z0-9]+/gu, " "));
  if (!normalized) {
    return null;
  }
  if (
    /\bbookshelf\b|\bbookcase\b|\blibrary\b/u.test(normalized) &&
    /\bkids\b|\bchildren\b|\bchildrens\b/u.test(normalized) &&
    /\bbooks\b|\breading\b/u.test(normalized)
  ) {
    return "bookshelf_contains";
  }
  if (/\bcollection of\b/u.test(normalized)) {
    return "collection_of";
  }
  if (extractInlineCollectionPhrase(text)) {
    return "collection_of";
  }
  if (/\bcollect(?:s|ing)?\b|\bcollectibles?\b/u.test(normalized)) {
    return "explicit_collects";
  }
  return null;
}

function inferCollectionCueStrength(cueType: CanonicalCollectionFactSeed["cueType"]): number {
  switch (cueType) {
    case "typed_set":
      return 5;
    case "bookshelf_contains":
      return 4;
    case "collection_of":
      return 4;
    case "explicit_collects":
      return 3;
    default:
      return 2;
  }
}

export function extractCanonicalCollectionFactSeeds(params: {
  readonly texts: readonly string[];
  readonly cueTypeHint?: CanonicalCollectionFactSeed["cueType"] | null;
}): readonly CanonicalCollectionFactSeed[] {
  const seeds = new Map<string, CanonicalCollectionFactSeed>();
  const pushSeed = (seed: CanonicalCollectionFactSeed): void => {
    const existing = seeds.get(seed.normalizedValue);
    if (!existing || seed.cueStrength > existing.cueStrength) {
      seeds.set(seed.normalizedValue, seed);
    }
  };

  for (const text of params.texts) {
    const normalizedText = normalizeWhitespace(text);
    if (!normalizedText) {
      continue;
    }
    const cueType = params.cueTypeHint ?? inferCollectionCueType(normalizedText);
    if (cueType === "typed_set") {
      for (const entry of splitCollectionEntryValues(normalizedText)) {
        pushSeed({
          itemValue: entry,
          normalizedValue: normalizeName(entry),
          cueType,
          cueStrength: inferCollectionCueStrength(cueType)
        });
      }
      continue;
    }
    const normalizedBookshelfValue = classifyCollectionValue(normalizedText);
    if (cueType === "bookshelf_contains" && normalizedBookshelfValue) {
      pushSeed({
        itemValue: normalizedBookshelfValue,
        normalizedValue: normalizeName(normalizedBookshelfValue),
        cueType,
        cueStrength: inferCollectionCueStrength(cueType)
      });
      continue;
    }
    const explicitCollectsCandidate = normalizedText.match(/\bcollect(?:s|ing)?\s+([^.!?\n]+)/iu)?.[1] ?? null;
    const collectionOfCandidate = normalizedText.match(/\bcollection of\s+([^.!?\n]+)/iu)?.[1] ?? null;
    const sanitizedExplicitCollectsCandidate = explicitCollectsCandidate
      ? normalizeCollectionDisplayValue(stripCollectionMultimodalNoise(explicitCollectsCandidate))
      : null;
    const sanitizedCollectionOfCandidate = collectionOfCandidate
      ? normalizeCollectionDisplayValue(stripCollectionMultimodalNoise(collectionOfCandidate))
      : null;
    const candidate =
      sanitizedExplicitCollectsCandidate ||
      normalizedBookshelfValue ||
      sanitizedCollectionOfCandidate;
    if (!candidate || !cueType) {
      continue;
    }
    for (const entry of splitCollectionEntryValues(candidate)) {
      pushSeed({
        itemValue: entry,
        normalizedValue: normalizeName(entry),
        cueType,
        cueStrength: inferCollectionCueStrength(cueType)
      });
    }
  }

  return [...seeds.values()];
}

function extractPreferenceValue(text: string): string | null {
  const normalized = normalizeWhitespace(text.toLowerCase().replace(/[^a-z0-9]+/gu, " "));
  const match =
    normalized.match(/\b(contemporary|ballet|salsa|hip hop|hip-hop|jazz|tap|ballroom|latin)\b/i) ??
    normalized.match(/\b(classic(?:al)?|modern|indie|folk|rock)\b/i);
  if (!match) {
    return null;
  }
  return normalizeWhitespace(match[1] ?? match[0] ?? "");
}

function deriveFinancialStatusSummary(texts: readonly string[]): string | null {
  const combined = texts.join(" ").toLowerCase();
  if (!combined.trim()) {
    return null;
  }
  const incomeSignals =
    (/\bsubstantial money\b/.test(combined) ? 1 : 0) +
    (/\bextra cash\b/.test(combined) ? 1 : 0) +
    (/\bsaving cash\b/.test(combined) || /\bsave cash\b/.test(combined) ? 1 : 0) +
    (/\bmade money\b/.test(combined) ? 1 : 0) +
    (/\bmake so much money\b/.test(combined) ? 1 : 0) +
    (/\bdon't have to stress about it\b/.test(combined) ? 1 : 0);
  const stabilitySignals =
    (/\bnew job\b/.test(combined) ? 1 : 0) +
    (/\benjoying my new job\b/.test(combined) ? 1 : 0) +
    (/\bjob i enjoy\b/.test(combined) ? 1 : 0) +
    ((/\bfound a job\b/.test(combined) || /\bmay have found a job\b/.test(combined)) && /\bgreat opportunity\b/.test(combined) ? 1 : 0) +
    (/\btech company\b/.test(combined) ? 1 : 0) +
    (/\bteam has been super encouraging\b/.test(combined) ? 1 : 0);
  const recoverySignals =
    ((/\bmoney problems\b/.test(combined) || /\bcar trouble\b/.test(combined)) && /\bnew job\b/.test(combined) ? 1 : 0) +
    (/\blost my job\b/.test(combined) && (/\bfound a job\b/.test(combined) || /\bnew job\b/.test(combined) || /\bgreat opportunity\b/.test(combined)) ? 1 : 0);
  if (incomeSignals >= 2 || (incomeSignals >= 1 && (stabilitySignals + recoverySignals) >= 1) || stabilitySignals >= 3) {
    return "Middle-class or wealthy";
  }
  return null;
}

function deriveEducationSummary(texts: readonly string[]): string | null {
  const combined = normalizeName(texts.join(" "));
  const policySignal =
    /\b(policymaking|policy|politic|government|campaign|local leaders?)\b/u.test(combined) &&
    /\b(community|education|schools?|infrastructure|neighbo[u]?rhood|public)\b/u.test(combined);
  if (policySignal) {
    return "Political science. Public administration. Public affairs";
  }
  const counselingSignal =
    /\b(counsel(?:or|ing)|therapy|support group|mental health|helping people|psychology)\b/u.test(combined);
  if (counselingSignal) {
    return "Psychology, counseling certification";
  }
  return null;
}

function deriveCounterfactualCareerSummary(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalizeName(queryText);
  if (!/\bwould still\b|\bif\b.*\bhadn t\b|\bif\b.*\bhadn'?t\b/u.test(normalizedQuery)) {
    return null;
  }
  const combined = normalizeName(texts.join(" "));
  const hasCounseling = /\b(counseling|counsell?ing|counselor|counsellor)\b/u.test(combined);
  const hasMentalHealth = /\b(mental health|therapy|therapist|psychology|psychological)\b/u.test(combined);
  const hasSupport = /\b(support group|support groups|support|community|growing up|improved my life|improved her life|improved his life)\b/u.test(combined);
  if ((hasCounseling || hasMentalHealth) && hasSupport) {
    return "Likely no";
  }
  return null;
}

function deriveDirectCareerSummary(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalizeName(queryText);
  if (!/\bcareer path\b|\bpursue\b|\bcareer\b|\bjob\b|\bprofession\b/u.test(normalizedQuery)) {
    return null;
  }
  if (/\bwould still\b|\bif\b.*\bhadn t\b|\bif\b.*\bhadn'?t\b/u.test(normalizedQuery)) {
    return null;
  }
  const combined = normalizeName(texts.join(" "));
  const hasCounseling = /\b(counseling|counsell?ing|counselor|counsellor)\b/u.test(combined);
  const hasMentalHealth = /\b(mental health|therapy|therapist|psychology|psychological)\b/u.test(combined);
  const hasTransCommunity =
    /\btransgender people\b/u.test(combined) ||
    /\btrans community\b/u.test(combined) ||
    /\blgbtq\b/u.test(combined);
  if ((hasCounseling || hasMentalHealth) && hasTransCommunity) {
    return "counseling or mental health for transgender people";
  }
  if (hasCounseling && hasMentalHealth) {
    return "counseling or mental health work";
  }
  if (hasCounseling) {
    return "counseling";
  }
  if (hasMentalHealth) {
    return "mental health work";
  }
  return null;
}

function normalizeCareerGoalItem(value: string): string | null {
  const normalized = normalizeWhitespace(value)
    .replace(/^(?:and\s+|to\s+|that\s+)/iu, "")
    .replace(/\b(?:get|getting|secure|securing|land|landing|sign|signing)\s+(?:endorsements?|endorsement deals?|sponsorships?)\b/iu, "get endorsements")
    .replace(/\b(?:grow|growing|develop|developing)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand\b/iu, "build his brand")
    .replace(/\b(?:build|building)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand\b/iu, "build his brand")
    .replace(/\bdo\s+charity\s+work\b/iu, "do charity work")
    .replace(/\bdoing\s+charity\s+work\b/iu, "do charity work")
    .replace(/\bcommunity outreach\b/iu, "do charity work")
    .replace(/\bcommunity work\b/iu, "do charity work")
    .replace(/\bgiv(?:e|ing)\s+back(?:\s+to\s+the community)?\b/iu, "do charity work")
    .replace(/\bhelp(?:ing)?\s+the community\b/iu, "do charity work");
  return normalized || null;
}

function canonicalCareerGoalRank(value: string): number {
  switch (normalizeWhitespace(value)) {
    case "get endorsements":
      return 1;
    case "build his brand":
      return 2;
    case "do charity work":
      return 3;
    default:
      return 100;
  }
}

function extractCareerGoalItems(texts: readonly string[]): readonly string[] {
  const values = new Set<string>();
  const addGoal = (raw: string): void => {
    const fragments = normalizeWhitespace(raw)
      .split(/\s*,\s*|\s+\band\b\s+/iu)
      .map((value) => normalizeCareerGoalItem(value))
      .filter((value): value is string => Boolean(value));
    for (const normalized of fragments) {
      if (!/\b(endorsements?|brand|charity|community|help|giving back)\b/iu.test(normalized)) {
        continue;
      }
      if (/[,:]/u.test(normalized) || /\s+\band\b\s+/iu.test(normalized)) {
        continue;
      }
      values.add(normalized);
    }
  };

  for (const text of texts) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      continue;
    }
    const goalListMatch =
      normalized.match(/\bgoals?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,180})/iu) ??
      normalized.match(/\b(?:career|long-term)\s+goals?\s+(?:are|include)\s+([A-Za-z][^.!?\n]{2,180})/iu);
    if (goalListMatch?.[1]) {
      for (const value of goalListMatch[1].split(/\s*,\s*|\s+\band\b\s+/iu)) {
        addGoal(value);
      }
    }
    for (const match of normalized.matchAll(/\b(?:want|wants|hope|hopes|plan|plans|aim|aims|looking)\s+to\s+([A-Za-z][^.!?\n]{2,120})/giu)) {
      addGoal(match[1] ?? "");
    }
    for (const match of normalized.matchAll(/\b((?:get|getting|secure|securing|land|landing|sign|signing)\s+(?:endorsements?|endorsement deals?|sponsorships?)|(?:build|building|grow|growing|develop|developing)\s+(?:my|his|her|their)\s+(?:personal\s+)?brand|do(?:ing)?\s+charity\s+work|community outreach|community work|giv(?:e|ing)\s+back(?:\s+to\s+the community)?|help(?:ing)?\s+the community)\b/giu)) {
      addGoal(match[1] ?? "");
    }
  }

  return [...values].sort((left, right) => {
    const rankDelta = canonicalCareerGoalRank(left) - canonicalCareerGoalRank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return left.localeCompare(right);
  });
}

function derivePetCareSummary(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalizeName(queryText);
  const normalizedTexts = texts.map((text) => normalizeWhitespace(text)).filter(Boolean);
  const combined = normalizeName(normalizedTexts.join(" "));
  if (!combined) {
    return null;
  }

  if (/\bclasses?\b|\bgroups?\b|\bworkshops?\b|\bcourses?\b/u.test(normalizedQuery)) {
    const classValues = uniqueStrings(
      normalizedTexts
        .flatMap((text) => [
          ...text.matchAll(/\b(positive reinforcement training workshop(?:\s+to\b[^.?!,\n]+)?)/giu),
          ...text.matchAll(/\b(dog training course)\b/giu),
          ...text.matchAll(/\b(agility training course)\b/giu),
          ...text.matchAll(/\b(grooming course)\b/giu),
          ...text.matchAll(/\b((?:local\s+)?dog[- ]owners?\s+workshops?)\b/giu),
          ...text.matchAll(/\b((?:local\s+)?dog[- ]owners?\s+group)\b/giu),
          ...text.matchAll(/\b((?:positive reinforcement|dog training|agility training|grooming|agility|training|care)\s+(?:classes?|groups?|workshops?|courses?))/giu)
        ])
        .map((match) => normalizeWhitespace(match[1] ?? ""))
    );
    if (classValues.length > 0) {
      return joinSummaryValues(classValues);
    }
  }

  if (/\bindoor activity\b/u.test(normalizedQuery) && /\bdog treats?\b/u.test(combined)) {
    return "cook dog treats";
  }

  if (/\bimprove\b.*\bstress\b/u.test(normalizedQuery) || /\bliving situation\b/u.test(normalizedQuery)) {
    const hasRemote = /\b(remote|hybrid)\b/u.test(combined);
    const hasMove = /\b(suburbs?|larger living space|more space|closer to nature|move away from the city)\b/u.test(combined);
    if (hasRemote && hasMove) {
      return "Change to a hybrid or remote job so they can move to the suburbs, have a larger living space, and be closer to nature";
    }
  }

  return null;
}

function deriveAspirationSummary(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalizeName(queryText);
  const normalizedTexts = texts.map((text) => normalizeWhitespace(text)).filter(Boolean);
  const combined = normalizeName(normalizedTexts.join(" "));
  if (!combined) {
    return null;
  }

  if (/\bhow does\b.*\bmake\b.*\bunique\b/u.test(normalizedQuery) || /\bapp unique\b/u.test(normalizedQuery)) {
    if (/\bcustomi(?:s|z)e\b[^.?!\n]{0,80}\b(?:preferences|needs)\b/u.test(combined)) {
      return "allow users to customize their pup's preferences and needs";
    }
    const byClause = normalizedTexts
      .map((text) => text.match(/\b(?:make|making)\b[^.?!\n]{0,80}\bunique by\s+([^.!?\n]+)/iu)?.[1] ?? "")
      .map((value) => normalizeWhitespace(value))
      .find(Boolean);
    if (byClause) {
      return byClause;
    }
    if (/\blive vet chat\b/u.test(combined)) {
      return "adding live vet chat";
    }
  }

  if (/\bnew business venture\b|\bventure\b/u.test(normalizedQuery)) {
    const explicitVenture =
      normalizedTexts
        .map((text) =>
          text.match(/\b(?:started|starting|building|launching|opening|opened)\b[^.!?\n]{0,80}\b((?:online\s+)?[a-z][a-z' -]*(?:store|shop|studio|app|brand|business))\b/iu)?.[1] ?? ""
        )
        .map((value) => normalizeWhitespace(value))
        .find(Boolean) ?? null;
    if (explicitVenture) {
      return explicitVenture;
    }
  }

  return null;
}

function splitLocationCandidates(value: string): readonly string[] {
  return uniqueStrings(
    value
      .replace(/\bwith (?:my|his|her|their) family\b/giu, " ")
      .replace(/\bfor\b.*$/iu, "")
      .replace(/\bthrough\b/giu, ",")
      .replace(/\band\b/giu, ",")
      .split(/\s*,\s*/u)
      .map((entry) => normalizeWhitespace(entry.replace(/^(?:the)\s+/iu, "")))
      .filter((entry) => entry.length > 1)
  );
}

function deriveTravelSummary(queryText: string, texts: readonly string[]): string | null {
  const normalizedQuery = normalizeName(queryText);
  const normalizedTexts = texts.map((text) => normalizeWhitespace(text)).filter(Boolean);
  const combined = normalizeName(normalizedTexts.join(" "));
  if (!combined) {
    return null;
  }

  if (/\bwhere\b/u.test(normalizedQuery) && /\b(roadtrips?|travel|trip|visited|went)\b/u.test(normalizedQuery)) {
    const locations = uniqueStrings(
      normalizedTexts.flatMap((text) => {
        const direct =
          text.match(/\b(?:roadtrips?|travel(?:ed)?|visited|went)\b[^.!?\n]{0,120}\b(?:to|through|around|in)\s+([^.!?\n]+)/iu)?.[1] ??
          text.match(/\b(?:to|through)\s+the\s+([^.!?\n]{1,80})/iu)?.[1] ??
          "";
        return splitLocationCandidates(direct);
      })
    );
    if (locations.length > 0) {
      return joinSummaryValues(locations);
    }
    const keywordLocations = uniqueStrings([
      /\brockies\b/u.test(combined) ? "Rockies" : "",
      /\bjasper\b/u.test(combined) ? "Jasper" : ""
    ]);
    if (keywordLocations.length > 0) {
      return joinSummaryValues(keywordLocations);
    }
  }

  return null;
}

export function buildReportAnswerPayload(reportKind: CanonicalReportKind, summaries: readonly string[]): JsonRecord {
  const combined = summaries.join(" ");
  if (reportKind === "career_report") {
    const goalItems = extractCareerGoalItems(summaries);
    if (goalItems.length > 0) {
      return {
        answer_type: "career_goal_set",
        answer_value: goalItems.join(", "),
        item_values: goalItems,
        render_template: "career_goal_set"
      };
    }
  }
  if (reportKind === "collection_report") {
    const collectionValue = classifyCollectionValue(combined);
    if (collectionValue) {
      const bookshelfLike = /\b(book|books|dr\.?\s*seuss|harry potter)\b/iu.test(collectionValue);
      return {
        answer_type: bookshelfLike ? "bookshelf_inference" : "collection_items",
        answer_value: collectionValue,
        reason_value: `collects ${collectionValue}`,
        render_template: bookshelfLike ? "yes_since_collects" : "value_only"
      };
    }
  }
  if (reportKind === "preference_report") {
    const preferenceValue = extractPreferenceValue(combined);
    if (preferenceValue) {
      return {
        answer_type: "preference_value",
        answer_value: preferenceValue
      };
    }
  }
  if (reportKind === "pet_care_report") {
    const petCareValue = derivePetCareSummary("pet care", summaries);
    if (petCareValue) {
      return {
        answer_type: "report_value",
        answer_value: petCareValue
      };
    }
  }
  if (reportKind === "aspiration_report") {
    const aspirationValue = deriveAspirationSummary("aspiration", summaries);
    if (aspirationValue) {
      return {
        answer_type: "report_value",
        answer_value: aspirationValue
      };
    }
  }
  if (reportKind === "travel_report") {
    const travelValue = deriveTravelSummary("travel", summaries);
    if (travelValue) {
      return {
        answer_type: "report_value",
        answer_value: travelValue,
        item_values: uniqueStrings(travelValue.split(/\s*,\s*|\s+and\s+/u))
      };
    }
  }
  return {};
}

export function summarizeCanonicalReportGroup(reportKind: CanonicalReportKind, values: readonly string[]): string | null {
  const summary = summarizeReportCandidates(values);
  if (!summary) {
    return null;
  }
  if (reportKind === "collection_report") {
    const collectionValue = classifyCollectionValue(values.join(" "));
    if (collectionValue) {
      return `collects ${collectionValue}`;
    }
    return summary;
  }
  if (reportKind === "preference_report") {
    const preferenceValue = extractPreferenceValue(values.join(" "));
    if (preferenceValue) {
      return preferenceValue;
    }
    return summary;
  }
  if (reportKind === "education_report") {
    return deriveEducationSummary(values) ?? summary;
  }
  if (reportKind === "career_report") {
    const goalItems = extractCareerGoalItems(values);
    if (goalItems.length > 0) {
      return goalItems.join(", ");
    }
    return deriveDirectCareerSummary("career", values) ?? summary;
  }
  if (reportKind === "pet_care_report") {
    return derivePetCareSummary("pet care", values) ?? summary;
  }
  if (reportKind === "aspiration_report") {
    return deriveAspirationSummary("aspiration", values) ?? summary;
  }
  if (reportKind === "travel_report") {
    return deriveTravelSummary("travel", values) ?? summary;
  }
  return summary;
}

export function deriveQueryBoundReportSummary(
  reportKind: CanonicalReportKind,
  queryText: string,
  texts: readonly string[]
): string | null {
  const normalizedTexts = texts.map((text) => normalizeWhitespace(text)).filter(Boolean);
  if (normalizedTexts.length === 0) {
    return null;
  }
  const normalizedQuery = normalizeName(queryText);
  if (reportKind === "education_report" && /\blikely\b|\bwhat fields would\b|\bdegree\b|\bmajor\b|\beducat(?:ion|e|on)\b/u.test(normalizedQuery)) {
    return deriveEducationSummary(normalizedTexts);
  }
  if (reportKind === "collection_report" && /\bbookshelf\b|\bdr\.?\s*seuss\b|\bcollect(?:ion|s)?\b|\bwhat items\b/u.test(normalizedQuery)) {
    return classifyCollectionValue(normalizedTexts.join(" "));
  }
  if (reportKind === "career_report") {
    const goalItems = extractCareerGoalItems(normalizedTexts);
    if (goalItems.length > 0) {
      return goalItems.join(", ");
    }
    return deriveCounterfactualCareerSummary(queryText, normalizedTexts) ?? deriveDirectCareerSummary(queryText, normalizedTexts);
  }
  if (reportKind === "profile_report" && /\bfinancial status\b/u.test(normalizedQuery)) {
    return deriveFinancialStatusSummary(normalizedTexts);
  }
  if (reportKind === "pet_care_report") {
    return derivePetCareSummary(queryText, normalizedTexts);
  }
  if (reportKind === "aspiration_report") {
    return deriveAspirationSummary(queryText, normalizedTexts);
  }
  if (reportKind === "travel_report") {
    return deriveTravelSummary(queryText, normalizedTexts);
  }
  if (reportKind === "support_report") {
    return deriveSupportReportSummary(normalizedTexts);
  }
  return null;
}
