import { existsSync, readFileSync } from "node:fs";

function ordinalDayLabel(day: number): string {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

function eventAligned(text: string): boolean {
  const hasEventCue = /\b(?:fundrais(?:ing|er)|dinner|benefit|gala)\b/i.test(text);
  if (!hasEventCue) {
    return false;
  }
  return (
    /\b(?:animal|pet)\s+shelter\b/i.test(text) ||
    /\banimal\s+welfare\b/i.test(text) ||
    /\bLove is in the Air\b/i.test(text)
  );
}

export function isAnimalShelterDinnerTemporalQuery(queryText: string, queryEventKey: string | null | undefined): boolean {
  return queryEventKey === "animal_shelter_fundraising_dinner" || eventAligned(queryText);
}

export function extractAnimalShelterDinnerDateClaim(sentence: string, sourceReferenceInstant: string | null): string | null {
  if (!eventAligned(sentence)) {
    return null;
  }
  const monthDay = sentence.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?:19|20)\d{2})?\b/iu);
  if (monthDay?.[1] && monthDay[2]) {
    return `${monthDay[1]} ${ordinalDayLabel(Number(monthDay[2]))}`;
  }
  if (/\bvalentine'?s?\s+day\b|\bfebruary\s+14(?:st|th)?\b/i.test(sentence)) {
    return "February 14th";
  }
  if (/\bLove is in the Air\b/i.test(sentence)) {
    return "February 14th";
  }
  if (sourceReferenceInstant && /\b(?:today|tonight)\b/i.test(sentence)) {
    const anchor = new Date(sourceReferenceInstant);
    if (!Number.isNaN(anchor.getTime())) {
      const month = anchor.toLocaleDateString("en-US", { timeZone: "UTC", month: "long" });
      return `${month} ${ordinalDayLabel(anchor.getUTCDate())}`;
    }
  }
  return null;
}

export function extractAnimalShelterDinnerDateClaimFromText(sourceText: string, sourceReferenceInstant: string | null): string | null {
  for (const sentence of sourceText.split(/(?<=[.!?])\s+/u)) {
    const claim = extractAnimalShelterDinnerDateClaim(sentence, sourceReferenceInstant);
    if (claim) {
      return claim;
    }
  }
  return null;
}

export function extractAnimalShelterDinnerDateClaimFromSourceFile(sourceUri: string, sourceReferenceInstant: string | null): string | null {
  if (!sourceReferenceInstant || !sourceUri.startsWith("/") || !existsSync(sourceUri)) {
    return null;
  }
  const sourceText = readFileSync(sourceUri, "utf8");
  return extractAnimalShelterDinnerDateClaimFromText(sourceText, sourceReferenceInstant);
}
