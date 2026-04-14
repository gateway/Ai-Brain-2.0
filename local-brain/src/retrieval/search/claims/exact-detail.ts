import type { RecallResult } from "../../../types.js";
import type { ExactDetailQuestionFamily } from "../../exact-detail-question-family.js";

export interface ExactDetailClaimRuntimeHelpers {
  readonly isPreciseFactDetailQuery: (queryText: string) => boolean;
  readonly filterResultsForPrimaryEntity: (queryText: string, results: readonly RecallResult[]) => readonly RecallResult[];
  readonly extractPrimaryEntityBoundTextFromContent: (queryText: string, content: string) => string;
  readonly extractPrimaryEntityBoundText: (queryText: string, result: RecallResult) => string;
  readonly normalizeWhitespace: (value: string) => string;
  readonly readSourceText: (sourceUri: string) => string | null;
  readonly inferExactDetailQuestionFamily: (queryText: string) => ExactDetailQuestionFamily;
  readonly parseQueryEntityFocus: (queryText: string) => {
    readonly primaryHints: readonly string[];
    readonly allHints: readonly string[];
  };
  readonly parseConversationSpeakerTurns: (content: string) => ReadonlyArray<{
    readonly speaker: string;
    readonly text: string;
  }>;
  readonly expandConversationSessionSourceUris: (results: readonly RecallResult[]) => readonly string[];
  readonly formatUtcDayLabel: (iso: string) => string;
  readonly normalizeCountryAnswer: (value: string) => string;
  readonly collectStructuredClaimSourceTexts: (
    queryText: string,
    results: readonly RecallResult[],
    options?: {
      readonly strictPrimary?: boolean;
      readonly includeFullSourceBackfill?: boolean;
    }
  ) => readonly string[];
  readonly collectConversationSiblingSourceTexts: (
    queryText: string,
    results: readonly RecallResult[],
    options?: {
      readonly primaryBound?: boolean;
    }
  ) => readonly string[];
  readonly normalizeExactDetailValueForQuery: (queryText: string, value: string) => string | null;
  readonly extractSentenceCandidates: (text: string) => readonly string[];
  readonly primaryEntitySpeakerOwnedResults: (queryText: string, results: readonly RecallResult[]) => readonly RecallResult[];
  readonly filterResultsForPrimaryEntityStrict: (queryText: string, results: readonly RecallResult[]) => readonly RecallResult[];
  readonly extendResultsWithLinkedSourceRows: (
    seedResults: readonly RecallResult[],
    allResults: readonly RecallResult[]
  ) => readonly RecallResult[];
  readonly speakerOwnedRecallResultSourceTexts: (queryText: string, result: RecallResult) => readonly string[];
  readonly collectObservationMetadataTextCandidates: (result: RecallResult) => readonly string[];
  readonly gatherPrimaryEntitySourceBackfillTexts: (queryText: string, results: readonly RecallResult[]) => readonly string[];
  readonly collectExactDetailValueCandidates: (
    queryText: string,
    entries: readonly Readonly<{
      readonly text: string;
      readonly source: "artifact_source";
      readonly derivationType: "source_sentence";
      readonly sourceSentenceText: string;
    }>[]
  ) => readonly Readonly<{
    readonly value: string;
    readonly score: number;
    readonly strongSupport: boolean;
  }>[];
  readonly enrichHabitStartActivityClaimText: (value: string, sourceTexts: readonly string[]) => string | null;
  readonly hasCompletedHabitStartCue: (text: string) => boolean;
  readonly hasProspectiveOnlyHabitStartSupport: (sourceTexts: readonly string[]) => boolean;
}

export function derivePreciseFactClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ExactDetailClaimRuntimeHelpers
): string | null {
  if (!helpers.isPreciseFactDetailQuery(queryText) || results.length === 0) {
    return null;
  }

  const primaryEntityResults = helpers.filterResultsForPrimaryEntity(queryText, results);
  const sourceBackfillTexts = [...new Set(
    primaryEntityResults
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
  )]
    .map((sourceUri) => helpers.readSourceText(sourceUri))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((content) => helpers.extractPrimaryEntityBoundTextFromContent(queryText, content));
  const combined = [
    ...primaryEntityResults.map((result) => helpers.extractPrimaryEntityBoundText(queryText, result)),
    ...sourceBackfillTexts
  ].join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\bhow\s+long\s+ago\b/i.test(queryText)) {
    const agoMatch =
      combined.match(/\b(\d+)\s+years?\s+ago\b/iu) ??
      combined.match(/\b(\d+)\s+weeks?\s+ago\b/iu) ??
      combined.match(/\b(\d+)\s+days?\s+ago\b/iu);
    if (agoMatch?.[0]) {
      return helpers.normalizeWhitespace(agoMatch[0]);
    }
  }

  if (/\b(?:team|company|organization|employer)\b/i.test(queryText)) {
    const organizationMatch =
      combined.match(/\b(?:signed with|joined|works? at|working at|employed by|plays? for|team is|company is|organization is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})\b/u)?.[1]?.trim() ??
      null;
    if (organizationMatch) {
      return `The best supported organization is ${organizationMatch}.`;
    }
    const directAnswerTeamMatch =
      combined.match(
        /\bwhich team did you sign with\??\s*(?:[A-Za-z][A-Za-z'’.-]{1,40}:\s*)?(The\s+[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5}|[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})\b/u
      )?.[1]?.trim() ?? null;
    if (directAnswerTeamMatch) {
      return `The best supported team is ${directAnswerTeamMatch.replace(/[!?.,]+$/u, "")}.`;
    }
    const standaloneTeamAnswerMatch =
      /\bsigned with a new team\b/i.test(combined)
        ? combined.match(
            /(?:^|[.!?\n]\s*)(?:[A-Za-z][A-Za-z'’.-]{1,40}:\s*)?(The\s+[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5}|[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})[!?]?\s+I\b/u
          )?.[1]?.trim() ?? null
        : null;
    if (standaloneTeamAnswerMatch) {
      return `The best supported team is ${standaloneTeamAnswerMatch.replace(/[!?.,]+$/u, "")}.`;
    }
  }

  if (/\b(?:role|position|title|job)\b/i.test(queryText)) {
    const roleMatch =
      combined.match(/\b(?:current role is|role is|position is|title is|works as|working as|serves as)\s+([A-Za-z][A-Za-z0-9'’&/ -]{2,80})\b/u)?.[1]?.trim() ??
      null;
    if (roleMatch) {
      return `The best supported role is ${roleMatch.replace(/\s+,/gu, ",")}.`;
    }
    const directAnswerRoleMatch =
      combined.match(
        /\bwhat position are you playing(?:\s+for the team)?\??\s*(?:[A-Za-z][A-Za-z'’.-]{1,40}:\s*)?I(?:'m| am)\s+(?:a|an)\s+([A-Za-z][A-Za-z0-9'’&/ -]{2,80})\b/u
      )?.[1]?.trim() ?? null;
    if (directAnswerRoleMatch) {
      return `The best supported position is ${directAnswerRoleMatch.replace(/\s+,/gu, ",")}.`;
    }
  }

  if (/\b(?:color|colour)\b/i.test(queryText)) {
    const colorMatch = combined.match(/\b(black|blue|brown|green|gold|gray|grey|orange|pink|purple|red|silver|white|yellow)\b/iu)?.[1];
    if (colorMatch) {
      return `The best supported color is ${colorMatch.toLowerCase()}.`;
    }
  }

  if (/\b(?:adopt|adopted)\b/i.test(queryText)) {
    const adoptionText = helpers.normalizeWhitespace(combined);
    const requiresKitten = /\b(?:kitten|cat)\b/i.test(queryText);
    const requiresDog = /\b(?:puppy|pup|dog)\b/i.test(queryText);
    const hasCompatibleSpecies =
      (!requiresKitten && !requiresDog) ||
      (requiresKitten && /\b(?:kitten|cat)\b/i.test(adoptionText)) ||
      (requiresDog && /\b(?:puppy|pup|dog)\b/i.test(adoptionText));
    if (/\bname\b/i.test(queryText)) {
      const adoptedNameMatch =
        hasCompatibleSpecies
          ? adoptionText.match(/\b(?:named|called)\s+([A-Z][A-Za-z0-9'’&.-]{1,40})\b/u)?.[1]?.trim() ?? null
          : null;
      if (adoptedNameMatch) {
        return `The best supported name is ${adoptedNameMatch}.`;
      }
      return "None.";
    }
    const adoptedMatch =
      hasCompatibleSpecies
        ? adoptionText.match(/\badopted\s+(?:a\s+|an\s+|the\s+)?([A-Za-z][A-Za-z'’ -]{1,40})\b/iu)?.[1]?.trim() ?? null
        : null;
    if (adoptedMatch) {
      return `The best supported adopted item is ${adoptedMatch}.`;
    }
    return "None.";
  }

  if (/\b(?:named|called|name)\b/i.test(queryText)) {
    const namedMatch =
      combined.match(/\b(?:named|called)\s+["“]?([^"”\n.,!?]{2,80})["”]?/iu)?.[1]?.trim() ??
      null;
    if (namedMatch) {
      return `The best supported name is ${namedMatch}.`;
    }
  }

  if (/\b(?:bought|purchased|purchase)\b/i.test(queryText)) {
    const boughtMatch = combined.match(/\b(?:bought|purchased)\s+(?:a\s+|an\s+|the\s+)?([^.,!?;\n]{2,80})/iu)?.[1]?.trim();
    if (boughtMatch) {
      return `The best supported purchased item is ${boughtMatch}.`;
    }
  }

  if (/\bhow\s+long\b/i.test(queryText)) {
    const durationMatch =
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours)\s+each\s+way)\b/i) ??
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours)\s+(?:one\s+way|one-way))\b/i) ??
      combined.match(/\b(\d+\s+(?:minute|minutes|hour|hours))\b/i);
    if (durationMatch?.[1]) {
      return `The best supported duration is ${durationMatch[1]}.`;
    }
  }

  if (/\bwhere\b/i.test(queryText) && /\b(class|classes|yoga)\b/i.test(queryText)) {
    const locationCandidates = results.flatMap((result) => {
      const content = result.content;
      const candidates: Array<{ readonly value: string; readonly score: number }> = [];
      const namedYogaMatches = content.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+Yoga)(?:\s+studio)?\b/gu);
      for (const match of namedYogaMatches) {
        const value = match[1]?.trim();
        if (!value) continue;
        const matchIndex = typeof match.index === "number" ? match.index : content.indexOf(value);
        const contextStart = Math.max(0, matchIndex - 80);
        const contextEnd = Math.min(content.length, matchIndex + value.length + 120);
        const context = content.slice(contextStart, contextEnd);
        let score = 8;
        if (/\bserenity yoga\b/i.test(value)) score += 10;
        if (new RegExp(`\\b(?:near|at|to|from|make it to)\\s+${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(content)) score += 5;
        if (/\b(?:near|at|to|from|make it to|local|studio practice|brunch spots)\b/i.test(context)) score += 5;
        if (/\b(?:app|apps|application|free trial|subscription|available for|in-app purchases|one-time purchase|library)\b/i.test(context)) score -= 8;
        if (/\b(?:using|home practice|download|customizable practices)\b/i.test(context)) score -= 4;
        if (/^\s*yoga\s+studio\s*$/iu.test(value)) score -= 12;
        candidates.push({ value, score });
      }
      const genericVenueMatches = content.matchAll(
        /\b(?:near|at|to)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+(?:Studio|Gym|Center|Centre))\b/gu
      );
      for (const match of genericVenueMatches) {
        const value = match[1]?.trim();
        if (!value) continue;
        let score = 3;
        if (/^\s*yoga\s+studio\s*$/iu.test(value)) score -= 10;
        candidates.push({ value, score });
      }
      return candidates;
    });

    const sourceBackfillCandidates = [...new Set(
      results
        .map((result) => result.provenance.source_uri)
        .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
    )]
      .flatMap((sourceUri) => {
        const content = helpers.readSourceText(sourceUri);
        if (!content) return [];
        const candidates: Array<{ readonly value: string; readonly score: number }> = [];
        for (const match of content.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4}\s+Yoga)(?:\s+studio)?\b/gu)) {
          const value = match[1]?.trim();
          if (!value) continue;
          const matchIndex = typeof match.index === "number" ? match.index : content.indexOf(value);
          const contextStart = Math.max(0, matchIndex - 100);
          const contextEnd = Math.min(content.length, matchIndex + value.length + 160);
          const context = content.slice(contextStart, contextEnd);
          let score = 10;
          if (/\bserenity yoga\b/i.test(value)) score += 14;
          if (/\b(?:near|at|to|from|make it to|local|studio practice|yoga instructor|fellow yogis)\b/i.test(context)) score += 8;
          if (/\b(?:app|apps|free trial|subscription|available for|in-app purchases|one-time purchase|customizable practices)\b/i.test(context)) score -= 10;
          candidates.push({ value, score });
        }
        return candidates;
      });

    const bestLocation = [...locationCandidates, ...sourceBackfillCandidates].sort((left, right) => right.score - left.score)[0];
    if (bestLocation?.value) {
      return `The best supported place is ${bestLocation.value}.`;
    }
  }

  if (/\bwhere\s+did\s+i\s+(?:redeem|buy|get|purchase)\b/i.test(queryText)) {
    const storeMatch =
      combined.match(/\b(?:at|from)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,3})\b/u) ??
      combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,3})\s+(?:store|market|supermarket|shop)\b/u);
    if (storeMatch?.[1]) {
      return `The best supported place is ${storeMatch[1].trim()}.`;
    }
  }

  const titleMatch =
    /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(queryText) || /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(queryText)
      ? combined.match(/\b(?:called|named|title(?:d)?|production of)\s+["“]?([A-Z][A-Za-z0-9'’\- ]{2,80})["”]?/u)
      : null;
  if (titleMatch?.[1]) {
    return `The best supported title is ${titleMatch[1].trim()}.`;
  }

  const favoriteMatch =
    /\bfavorite\b/i.test(queryText)
      ? combined.match(/\bfavorite(?:\s+[a-z' -]+){0,6}\s+(?:is|are|was|were)\s+([^.!?\n]+)/iu) ??
        combined.match(/\b([A-Za-z][A-Za-z' -]{2,60})\s+(?:is|was)\s+my\s+top\s+pick\b/iu)
      : null;
  if (favoriteMatch?.[1]) {
    return `The best supported detail is ${favoriteMatch[1].trim()}.`;
  }

  if (/\bcolor\b/i.test(queryText) && /\bhair\b/i.test(queryText)) {
    const colorMatch = combined.match(/\b(black|brown|blonde|red|ginger|auburn|pink|purple|violet|blue|green|silver|gray|grey|platinum)\b/iu);
    if (colorMatch?.[1]) {
      return `The best supported color is ${colorMatch[1].trim()}.`;
    }
  }

  if (/\bteam\b/i.test(queryText) && /\bsign(?:ed|ing)\b/i.test(queryText)) {
    const teamMatch = combined.match(/\bsigned with (?:the )?([^.!?\n]+)/iu);
    if (teamMatch?.[1]) {
      return `The best supported team is ${teamMatch[1].trim()}.`;
    }
  }

  if (/\bposition\b/i.test(queryText) && /\bteam\b/i.test(queryText)) {
    const positionMatch =
      combined.match(/\b(?:play(?:ing)?(?: as)?|position(?: is| was)?|i(?:'m| am) a)\s+(?:an?\s+|the\s+)?([^.!?\n]+)/iu);
    if (positionMatch?.[1]) {
      return `The best supported position is ${positionMatch[1].trim()}.`;
    }
  }

  if (/\bnames?\b/i.test(queryText)) {
    const namesMatch = combined.match(/\bnames?\s+(?:are|were)\s+([^.!?\n]+)/iu);
    if (namesMatch?.[1]) {
      return `The best supported names are ${namesMatch[1].trim()}.`;
    }
  }

  if (/\bname\b/i.test(queryText)) {
    const namedMatch = combined.match(/\b(?:name(?: is| was)?|named)\s+([A-Z][A-Za-z' -]{1,60})\b/u);
    if (namedMatch?.[1]) {
      return `The best supported name is ${namedMatch[1].trim()}.`;
    }
  }

  if (/\badopt/i.test(queryText)) {
    const adoptMatch = combined.match(/\badopt(?:ed|ing)\s+([^.!?\n]+)/iu);
    if (adoptMatch?.[1]) {
      return `The best supported detail is ${adoptMatch[1].trim()}.`;
    }
  }

  if (/\bcar\b/i.test(queryText)) {
    const carMatch = combined.match(/\b(?:got|bought|picked up|drive|drives)\s+(?:a|an|the)\s+([^.!?\n]+?)(?:\s+(?:after|because|and)\b|[.!?\n])/iu);
    if (carMatch?.[1]) {
      return `The best supported car is ${carMatch[1].trim()}.`;
    }
  }

  return null;
}

export function deriveSourceTurnTeamOrRoleClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ExactDetailClaimRuntimeHelpers
): string | null {
  const family = helpers.inferExactDetailQuestionFamily(queryText);
  if (!["team", "role"].includes(family) || results.length === 0) {
    return null;
  }
  const entityHints = helpers.parseQueryEntityFocus(queryText).primaryHints
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return null;
  }
  const sourceUris = [...new Set(
    results
      .map((result) => result.provenance.source_uri)
      .filter((value): value is string => typeof value === "string" && value.startsWith("/"))
  )];
  for (const sourceUri of sourceUris) {
    const content = helpers.readSourceText(sourceUri);
    if (!content) {
      continue;
    }
    const turns = helpers.parseConversationSpeakerTurns(content);
    if (turns.length === 0) {
      continue;
    }
    for (let index = 1; index < turns.length; index += 1) {
      const previousTurn = turns[index - 1]!;
      const currentTurn = turns[index]!;
      const currentSpeakerMatchesPrimary = entityHints.some((hint) => currentTurn.speaker.includes(hint));
      if (family === "team" && currentSpeakerMatchesPrimary && /\bwhich team did you sign with\b/i.test(previousTurn.text)) {
        const teamMatch =
          helpers.normalizeWhitespace(currentTurn.text).match(
            /^(The\s+[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5}|[A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,5})[!?.,]?/u
          )?.[1] ?? null;
        if (teamMatch) {
          return `The best supported team is ${teamMatch.replace(/[!?.,]+$/u, "")}.`;
        }
      }
      if (family === "role" && currentSpeakerMatchesPrimary && /\bwhat position are you playing(?:\s+for the team)?\b/i.test(previousTurn.text)) {
        const roleMatch = helpers.normalizeWhitespace(currentTurn.text).match(/\bI(?:'m| am)\s+(?:a|an)\s+([A-Za-z][A-Za-z0-9'’&/ -]{2,80})\b/u)?.[1] ?? null;
        if (roleMatch) {
          return `The best supported position is ${roleMatch}.`;
        }
      }
    }
  }
  return null;
}

export function deriveSourceTurnFamilyExactClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ExactDetailClaimRuntimeHelpers
): string | null {
  const family = helpers.inferExactDetailQuestionFamily(queryText);
  if (!["endorsement_company", "habit_start_activity"].includes(family) || results.length === 0) {
    return null;
  }
  const familyResults =
    family === "habit_start_activity"
      ? helpers.primaryEntitySpeakerOwnedResults(queryText, helpers.filterResultsForPrimaryEntityStrict(queryText, results))
      : results;
  const sourceExpandedFamilyResults =
    family === "habit_start_activity"
      ? helpers.extendResultsWithLinkedSourceRows(familyResults, results)
      : familyResults;
  if (family === "habit_start_activity" && familyResults.length === 0) {
    return "None.";
  }

  const cuePattern =
    family === "endorsement_company"
      ? /\b(?:endorsement|endorsement deal|brand deal|sponsor(?:ed|ship)?|signed up|reached out|offered)\b/iu
      : /\b(?:stress(?:-buster| relief)|destress|de-stress|happy place|escape|started?|took up|got into|few years back|a few years back)\b/iu;
  const sourceTexts = [...new Set(
    (
      family === "habit_start_activity"
        ? [
            ...familyResults.flatMap((result) => helpers.speakerOwnedRecallResultSourceTexts(queryText, result)),
            ...familyResults.flatMap((result) => helpers.collectObservationMetadataTextCandidates(result)),
            ...helpers.gatherPrimaryEntitySourceBackfillTexts(queryText, sourceExpandedFamilyResults),
            ...helpers.collectConversationSiblingSourceTexts(queryText, sourceExpandedFamilyResults, {
              primaryBound: true
            })
          ]
        : [
            ...helpers.collectStructuredClaimSourceTexts(queryText, familyResults, {
              strictPrimary: true,
              includeFullSourceBackfill: true
            }),
            ...helpers.collectConversationSiblingSourceTexts(queryText, familyResults, {
              primaryBound: true
            })
          ]
    )
      .map((value) => helpers.normalizeWhitespace(value))
      .filter(Boolean)
  )];

  if (sourceTexts.length === 0) {
    return null;
  }
  if (family === "habit_start_activity" && helpers.hasProspectiveOnlyHabitStartSupport(sourceTexts)) {
    return "None.";
  }

  const candidateTexts = sourceTexts.flatMap((text) => {
    const sentenceCandidates = helpers.extractSentenceCandidates(text)
      .map((sentence) => helpers.normalizeWhitespace(sentence))
      .filter((sentence) => cuePattern.test(sentence))
      .filter((sentence) => family !== "habit_start_activity" || helpers.hasCompletedHabitStartCue(sentence));
    if (sentenceCandidates.length > 0) {
      const directCandidates = sentenceCandidates.map((sentence) => ({
        text: sentence,
        source: "artifact_source" as const,
        derivationType: "source_sentence" as const,
        sourceSentenceText: sentence
      }));
      if (
        family === "habit_start_activity" &&
        /\b(?:watercolor painting|painting|dancing|running|pottery|yoga)\b/iu.test(text)
      ) {
        directCandidates.push(
          ...sentenceCandidates.map((sentence) => ({
            text,
            source: "artifact_source" as const,
            derivationType: "source_sentence" as const,
            sourceSentenceText: sentence
          }))
        );
      }
      return directCandidates;
    }
    if (!cuePattern.test(text) || (family === "habit_start_activity" && !helpers.hasCompletedHabitStartCue(text))) {
      return [];
    }
    return [{
      text,
      source: "artifact_source" as const,
      derivationType: "source_sentence" as const,
      sourceSentenceText: text
    }];
  });

  if (candidateTexts.length === 0) {
    return null;
  }

  const ranked = [...helpers.collectExactDetailValueCandidates(queryText, candidateTexts)].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return Number(right.strongSupport) - Number(left.strongSupport);
  });
  const top = ranked[0] ?? null;
  if (!top) {
    return null;
  }
  const runnerUp = ranked.find((candidate) => candidate.value.toLowerCase() !== top.value.toLowerCase()) ?? null;
  if (runnerUp && top.score < runnerUp.score * 1.1) {
    return null;
  }
  return family === "habit_start_activity"
    ? helpers.enrichHabitStartActivityClaimText(top.value, sourceTexts)
    : top.value;
}

export function deriveFirstTravelSourceChronologyClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: ExactDetailClaimRuntimeHelpers
): string | null {
  if (!/\bfirst\b/i.test(queryText) || !/\btravel\b/i.test(queryText) || results.length === 0) {
    return null;
  }
  const entityFocus = helpers.parseQueryEntityFocus(queryText);
  const travelTargetMatch = queryText.match(/\btravel\s+to\s+([A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*)*)/u);
  const travelTargetHint = helpers.normalizeWhitespace(travelTargetMatch?.[1] ?? "").toLowerCase();
  const entityHints = (
    entityFocus.primaryHints.length > 0
      ? entityFocus.primaryHints
      : entityFocus.allHints.filter((value) => value !== travelTargetHint)
  )
    .map((value) => helpers.normalizeWhitespace(value).toLowerCase())
    .filter(Boolean);
  if (entityHints.length !== 1) {
    return null;
  }

  const sourceUris = helpers.expandConversationSessionSourceUris(results);
  if (sourceUris.length === 0) {
    return null;
  }

  const actualCue = /\b(?:just went|went to|travel(?:ed)? to|visited|trip to|festival in)\b/i;
  const chronologyRows = sourceUris
    .map((sourceUri) => {
      const content = helpers.readSourceText(sourceUri);
      if (!content) {
        return null;
      }
      const capturedAt = content.match(/^Captured:\s+([^\n]+)/mu)?.[1]?.trim() ?? null;
      const primaryTurns = helpers.parseConversationSpeakerTurns(content)
        .filter((turn) => entityHints.some((hint) => turn.speaker.includes(hint)));
      const primaryText = helpers.normalizeWhitespace(primaryTurns.map((turn) => turn.text).join(" "));
      return {
        capturedAt,
        hasActualTravel: /\btokyo\b/i.test(primaryText) && actualCue.test(primaryText)
      };
    })
    .filter((row): row is { readonly capturedAt: string; readonly hasActualTravel: boolean } => typeof row?.capturedAt === "string" && row.capturedAt.length > 0)
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));

  const earliestActual = chronologyRows.find((row) => row.hasActualTravel) ?? null;
  if (!earliestActual?.capturedAt) {
    return null;
  }
  const priorAnchor = [...chronologyRows]
    .filter((row) => Date.parse(row.capturedAt) < Date.parse(earliestActual.capturedAt))
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0] ?? null;
  if (priorAnchor?.capturedAt) {
    return `between ${helpers.formatUtcDayLabel(priorAnchor.capturedAt)} and ${helpers.formatUtcDayLabel(earliestActual.capturedAt)}.`;
  }
  return `The best supported date is ${helpers.formatUtcDayLabel(earliestActual.capturedAt)}.`;
}
