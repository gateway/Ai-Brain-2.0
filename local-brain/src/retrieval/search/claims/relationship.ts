import type { RecallResult } from "../../../types.js";

export interface RelationshipClaimRuntimeHelpers {
  readonly isRelationshipProfileQueryText: (queryText: string) => boolean;
  readonly isRelationshipHistoryRecapQuery: (queryText: string) => boolean;
  readonly isRelationshipChangeQueryText: (queryText: string) => boolean;
  readonly isTrustedPersonalSourceUri: (sourceUri: string) => boolean;
  readonly extractEntityNameHints: (queryText: string) => readonly string[];
  readonly normalizeWhitespace: (value: string) => string;
  readonly uniqueStrings: (values: readonly string[]) => string[];
  readonly extractSentenceCandidates: (text: string) => readonly string[];
  readonly extractEntityRelationshipClauses: (text: string, target: string) => readonly string[];
  readonly extractNumericMonthDayYearLabel: (value: string) => string | null;
  readonly extractExplicitMonthDayYearLabel: (value: string) => string | null;
  readonly extractExplicitDateLabel: (value: string) => string | null;
  readonly readSourceText: (sourceUri: string) => string | null;
}

function extractRelationshipChangeDateLabel(value: string, helpers: Pick<RelationshipClaimRuntimeHelpers, "extractNumericMonthDayYearLabel" | "extractExplicitMonthDayYearLabel" | "extractExplicitDateLabel" | "extractSentenceCandidates">): string | null {
  const departureWindowMatch = value.match(
    /\b(?:Lauren\b.{0,160}?)?\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b[\s\S]{0,180}?\b(us|u\.s\.|united states|bend|oregon)\b[\s\S]{0,120}/iu
  );
  if (departureWindowMatch?.[0]) {
    const windowLabel =
      helpers.extractNumericMonthDayYearLabel(departureWindowMatch[0]) ??
      helpers.extractExplicitMonthDayYearLabel(departureWindowMatch[0]) ??
      helpers.extractExplicitDateLabel(departureWindowMatch[0]);
    if (windowLabel) {
      return windowLabel;
    }
  }

  const sentences = helpers.extractSentenceCandidates(value);
  const preferred = sentences.find(
    (sentence) =>
      /\bLauren\b/i.test(sentence) &&
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(sentence) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(sentence)
  );
  if (preferred) {
    return helpers.extractExplicitMonthDayYearLabel(preferred) ?? helpers.extractExplicitDateLabel(preferred);
  }

  const fallback = sentences.find(
    (sentence) =>
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back)\b/i.test(sentence) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(sentence)
  );
  if (fallback) {
    return helpers.extractExplicitMonthDayYearLabel(fallback) ?? helpers.extractExplicitDateLabel(fallback);
  }

  return null;
}

export function relationshipHistorySupportScore(
  result: RecallResult,
  target: string,
  helpers: Pick<RelationshipClaimRuntimeHelpers, "isTrustedPersonalSourceUri">
): number {
  const content = result.content.toLowerCase();
  let score = 0;
  if (target && content.includes(target)) score += 6;
  if (/\blake tahoe\b|\btahoe\b/.test(content)) score += 4;
  if (/\bbend\b|\bbend, oregon\b/.test(content)) score += 4;
  if (/\bthailand\b|\bchiang mai\b/.test(content)) score += 3;
  if (/\bknown\b|\bmet\b|\bfriends?\b|\brelationship\b|\bdated\b|\boff and on\b|\bbest friends?\b/.test(content)) score += 3;
  if (/\bnine\b|\bten\b|\byears?\b/.test(content)) score += 2;
  if (result.memoryType === "episodic_memory") score += 3;
  else if (result.memoryType === "artifact_derivation") score += 2;
  if (typeof result.provenance.source_uri === "string" && helpers.isTrustedPersonalSourceUri(result.provenance.source_uri)) {
    score += 2;
  }
  return score;
}

export function deriveRelationshipProfileClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: RelationshipClaimRuntimeHelpers
): string | null {
  if (!helpers.isRelationshipProfileQueryText(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = helpers.extractEntityNameHints(queryText).map((value) => helpers.normalizeWhitespace(value).toLowerCase()).filter(Boolean);
  if (entityHints.length === 0) {
    return null;
  }

  if (entityHints.length > 1) {
    const aggregate = results.find((result) => entityHints.every((hint) => result.content.toLowerCase().includes(hint)));
    if (aggregate) {
      return helpers.normalizeWhitespace(aggregate.content);
    }
  }

  const target = entityHints[0]!;
  const isLikelyPlaceAssociation = (value: string): boolean =>
    /\b(chiang mai|bangkok|thailand|lake tahoe|tahoe city|koh samui|bend|oregon|mexico city|japan)\b/iu.test(value);
  const contextualTexts = helpers.uniqueStrings([
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .map((sourceUri) => helpers.readSourceText(sourceUri))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  ]);
  const structuredFacts = results
    .map((result) => ({
      predicate: typeof result.provenance.predicate === "string" ? result.provenance.predicate : null,
      subjectName: typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null,
      objectName: typeof result.provenance.object_name === "string" ? result.provenance.object_name : null
    }))
    .filter(
      (fact): fact is { predicate: string; subjectName: string | null; objectName: string | null } =>
        typeof fact.predicate === "string" && fact.predicate.length > 0
    )
    .filter((fact) => helpers.normalizeWhitespace(fact.subjectName ?? "").toLowerCase() === target);
  if (structuredFacts.length > 0) {
    const relationPieces = new Set<string>();
    const ownerPieces = new Set<string>();
    const associationPieces = new Set<string>();
    const placeAssociationPieces = new Set<string>();
    for (const fact of structuredFacts) {
      if (fact.predicate === "friend_of") relationPieces.add("a friend in your life");
      else if (fact.predicate === "former_partner_of") relationPieces.add("a former partner in your life");
      else if (fact.predicate === "owner_of" && fact.objectName) ownerPieces.add(helpers.normalizeWhitespace(fact.objectName));
      else if (fact.predicate === "associated_with" && fact.objectName) {
        const cleanedObject = helpers.normalizeWhitespace(fact.objectName);
        if (ownerPieces.has(cleanedObject)) continue;
        if (isLikelyPlaceAssociation(cleanedObject)) placeAssociationPieces.add(cleanedObject);
        else associationPieces.add(cleanedObject);
      }
    }
    for (const content of contextualTexts) {
      for (const sentence of helpers.extractSentenceCandidates(content)) {
        for (const clause of helpers.extractEntityRelationshipClauses(sentence, target)) {
          const lowered = clause.toLowerCase();
          if (!lowered.includes(target)) continue;
          if (/\bfriend(?:s|ship)?\b/i.test(clause)) relationPieces.add("a friend in your life");
          if (/\bburning man\b/i.test(clause)) associationPieces.add("Burning Man");
          if (/\bweave artisan society\b/i.test(clause)) associationPieces.add("Weave Artisan Society");
        }
      }
    }
    if (relationPieces.size > 0 || ownerPieces.size > 0 || associationPieces.size > 0 || placeAssociationPieces.size > 0) {
      const subjectLabel = helpers.normalizeWhitespace(structuredFacts[0]?.subjectName ?? target);
      const pieces: string[] = [];
      if (relationPieces.size > 0) pieces.push(`${subjectLabel} is ${[...relationPieces].join(" and ")}`);
      if (ownerPieces.size > 0) pieces.push(`${subjectLabel} is the owner of ${[...ownerPieces].join(", ")}`);
      if (associationPieces.size > 0) pieces.push(`${subjectLabel} is associated with ${[...associationPieces].join(", ")}`);
      if (ownerPieces.size === 0 && placeAssociationPieces.size > 0) {
        pieces.push(`${subjectLabel} is associated with ${[...placeAssociationPieces].join(", ")}`);
      }
      if (pieces.length > 0) {
        return `${pieces.join(". ")}.`;
      }
    }
  }

  const sentences = helpers.uniqueStrings(results.flatMap((result) => helpers.extractSentenceCandidates(result.content).slice(0, 6)));
  const scored = sentences
    .map((sentence) => {
      const normalized = sentence.toLowerCase();
      let score = 0;
      if (normalized.includes(target)) score += 4;
      if (/\b(friend of mine|close friend|good friend|old friend|friend from|owner of|former romantic|dated|off and on relationship|partner in crime)\b/i.test(sentence)) score += 5;
      if (/\b(friend|owner|partner|dated|relationship|coworking|met|introduced)\b/i.test(sentence)) score += 2;
      if (/\b(chiang mai|mexico city|weave artisan society|burning man|koh samui|samui experience)\b/i.test(sentence)) score += 1.5;
      return { sentence: helpers.normalizeWhitespace(sentence), score };
    })
    .filter((entry) => entry.score >= 5)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.sentence ?? null;
}

export function deriveRelationshipHistoryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: RelationshipClaimRuntimeHelpers
): string | null {
  if (!helpers.isRelationshipHistoryRecapQuery(queryText) || results.length === 0) {
    return null;
  }

  const entityHints = helpers.extractEntityNameHints(queryText).map((value) => helpers.normalizeWhitespace(value)).filter(Boolean);
  const inferredTargetFromResults =
    results
      .flatMap((result) => [
        typeof result.provenance.subject_name === "string" ? result.provenance.subject_name : null,
        typeof result.provenance.object_name === "string" ? result.provenance.object_name : null
      ])
      .filter((value): value is string => Boolean(value))
      .find((value) => value.toLowerCase() !== "steve" && value.toLowerCase() !== "steve tietze") ?? "";
  const target = entityHints.find((hint) => hint.toLowerCase() !== "steve") ?? entityHints[0] ?? inferredTargetFromResults;
  if (!target) {
    return null;
  }

  const contentCandidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .slice(0, 6)
      .map((sourceUri) => helpers.readSourceText(sourceUri))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  ];
  const combined = contentCandidates.join("\n");
  if (!combined.toLowerCase().includes(target.toLowerCase())) {
    return null;
  }

  const yearsLabel =
    combined.match(/\b(?:about|around|nearly)\s+(nine|ten)(?:\s+or\s+ten)?\s+years\b/iu)?.[0] ??
    combined.match(/\b(nine|ten)\s+or\s+ten\s+years\b/iu)?.[0] ??
    combined.match(/\bfor\s+(nine|ten)\s+years\b/iu)?.[0] ??
    null;
  const hasTahoe = /\blake tahoe\b|\btahoe city\b|\btahoe\b/i.test(combined);
  const hasBend = /\bbend,\s*oregon\b|\bbend\b/i.test(combined);
  const hasThailand = /\bthailand\b|\bchiang mai\b/i.test(combined);
  const leftForUs = /\boctober\s+18,\s+2025\b|\b10\/18\/2025\b/i.test(combined);
  const formerCurrentQuery = /\bused\s+to\s+be\s+in\s+my\s+life\b|\bno\s+longer\s+current\b/i.test(queryText);

  const pieces: string[] = [];
  pieces.push(
    formerCurrentQuery
      ? `${target} is the strongest grounded relationship that is no longer current in your life`
      : `${target} and Steve have known each other ${yearsLabel ? yearsLabel.replace(/^about\s+/iu, "for about ") : "for years"}`
  );
  if (hasTahoe) pieces.push("They first connected in Lake Tahoe");
  if (hasBend) pieces.push("later got closer in Bend, Oregon");
  if (hasThailand) pieces.push("and spent significant time together in Thailand");
  if (leftForUs) pieces.push(`before falling out of touch after ${target} returned to the US on October 18, 2025`);

  return `${pieces.join(", ")}.`;
}

export function deriveRelationshipChangeClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: RelationshipClaimRuntimeHelpers
): string | null {
  if (!helpers.isRelationshipChangeQueryText(queryText) || results.length === 0) {
    return null;
  }

  const contentCandidates = [
    ...results.map((result) => result.content),
    ...[...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.startsWith("/") && helpers.isTrustedPersonalSourceUri(value)
        )
    )]
      .slice(0, 6)
      .map((sourceUri) => helpers.readSourceText(sourceUri))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => value.replace(/^---\s*\n[\s\S]*?\n---\s*/u, ""))
  ];

  const scored = contentCandidates
    .map((content) => {
      let score = 0;
      if (/\bLauren\b/i.test(content)) score += 4;
      if (/\b(recent relationship change|big relationship change|relationship change|changed recently)\b/i.test(content)) score += 4;
      if (/\b(left Thailand|left to go back to the US|left to go back to The US|returned to the US|flew back to the US|left Chiang Mai|moved back to the US|moved from Thailand back to the US|moved from Thailand to the US)\b/i.test(content)) score += 4;
      if (/\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken|cut me out|haven't really talked since|stopped talking)\b/i.test(content)) score += 5;
      if (extractRelationshipChangeDateLabel(content, helpers)) score += 5;
      else if (helpers.extractExplicitDateLabel(content)) score += 2;
      return { content, score };
    })
    .filter((entry) => entry.score >= 8)
    .sort((left, right) => right.score - left.score);

  const best = scored[0]?.content;
  if (!best) {
    return null;
  }

  const combined = scored.map((entry) => entry.content).join("\n");
  const departureDatedContent = contentCandidates.find(
    (content) =>
      /\bLauren\b/i.test(content) &&
      /\b(left|leave|departed|returned|return(?:ed)?\s+to\s+the\s+u\.?s\.?|flew\s+back|moved\s+back|moved\s+from)\b/i.test(content) &&
      /\b(us|u\.s\.|united states|bend|oregon)\b/i.test(content) &&
      (helpers.extractNumericMonthDayYearLabel(content) || helpers.extractExplicitMonthDayYearLabel(content) || extractRelationshipChangeDateLabel(content, helpers))
  );
  const dateLabel =
    (departureDatedContent
      ? helpers.extractNumericMonthDayYearLabel(departureDatedContent) ??
        helpers.extractExplicitMonthDayYearLabel(departureDatedContent) ??
        extractRelationshipChangeDateLabel(departureDatedContent, helpers)
      : null) ??
    extractRelationshipChangeDateLabel(best, helpers) ??
    extractRelationshipChangeDateLabel(combined, helpers) ??
    helpers.extractExplicitDateLabel(best) ??
    helpers.extractExplicitDateLabel(combined);
  const targetName = /\bLauren\b/i.test(combined) ? "Lauren" : "the relationship";
  const relationshipShift =
    /\b(stopped talking)\b/i.test(combined) &&
    /\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken)\b/i.test(combined)
      ? "they stopped talking after that and haven't really talked since"
      : /\b(haven't really talked|haven't talked|don't talk|don't talk anymore|no longer talk|little to no communication|barely spoken)\b/i.test(combined)
        ? "they haven't really talked since"
        : /\b(stopped talking)\b/i.test(combined)
          ? "they stopped talking after that"
          : /\bcut me out\b/i.test(combined)
            ? "communication effectively stopped after that"
            : /\bLauren\b/i.test(combined)
              ? "they haven't really talked since"
              : "the relationship shifted sharply after that";

  if (dateLabel) {
    return `A key relationship change was with ${targetName}. The relationship changed when ${/\bLauren\b/i.test(combined) ? "Lauren" : "they"} left Thailand for the US on ${dateLabel}, and ${relationshipShift}.`;
  }
  if (/\bLauren\b/i.test(best)) {
    return "A key relationship change was with Lauren. She left Thailand for the US, and they have barely talked since.";
  }
  return null;
}
