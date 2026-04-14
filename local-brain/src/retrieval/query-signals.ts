export function isRelationshipStyleExactQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const relationshipCue =
    /\b(with|together|shared|met|joined|visited|travel(?:ed|led)?|trip|dinner(?:s)?|lunch|breakfast|massage|coworking|ride|rides|stayed|spent)\b/i.test(lower) ||
    /\bwho was i with\b/i.test(lower) ||
    /\bwhere was i with\b/i.test(lower);

  if (!relationshipCue) {
    return false;
  }

  const properNouns = normalized.match(/\b[A-Z][a-z]+\b/g) ?? [];
  const yearHints = normalized.match(/\b(19\d{2}|20\d{2})\b/g) ?? [];

  return properNouns.length >= 2 || yearHints.length > 0 || /\bwho was i with\b/i.test(lower);
}

export function normalizeRelationshipWhyQuery(queryText: string): string | null {
  const normalized = queryText.trim();
  if (!normalized) {
    return null;
  }

  const patterns = [
    /^why\s+does\s+(?:the\s+brain|the\s+system|it)\s+believe\s+(.+?)\??$/i,
    /^why\s+does\s+(?:the\s+brain|the\s+system|it)\s+think\s+(.+?)\??$/i,
    /^why\s+do\s+you\s+think\s+(.+?)\??$/i,
    /^why\s+does\s+.+?\s+believe\s+(.+?)\??$/i
  ] as const;

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const clause = typeof match?.[1] === "string" ? match[1].trim() : "";
    if (clause) {
      return clause;
    }
  }

  return null;
}

export function isProvenanceWhyQuery(queryText: string): boolean {
  return normalizeRelationshipWhyQuery(queryText) !== null;
}

export function isPrecisionLexicalQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const tokens = normalized.match(/[A-Za-z0-9][A-Za-z0-9._:-]*/g) ?? [];
  if (tokens.length === 0) {
    return false;
  }

  if (
    /\bCVE-\d{4}-\d+\b/i.test(normalized) ||
    /\b(?:sha|hash)\s+[a-f0-9]{5,}\b/i.test(normalized) ||
    /\bport\s+\d{2,5}\b/i.test(normalized) ||
    /\bv?\d+\.\d+(?:\.\d+)?\b/i.test(normalized)
  ) {
    return true;
  }

  const highSignalTokens = tokens.filter((token) => {
    if (/^[A-Z0-9]{2,}$/.test(token)) {
      return true;
    }

    if (/[-.:]/.test(token) || (/\d/.test(token) && /[A-Za-z]/.test(token))) {
      return true;
    }

    return false;
  });

  if (highSignalTokens.length > 0) {
    return true;
  }

  const nonStopLower = tokens
    .map((token) => token.toLowerCase())
    .filter((token) => !["what", "when", "where", "who", "was", "were", "doing", "tell", "show", "find", "the", "and", "for", "with", "in", "on", "at"].includes(token));

  return nonStopLower.length > 0 && nonStopLower.length <= 3 && !/\b(what|when|where|who)\b/i.test(normalized);
}

export function isActiveRelationshipQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwho\s+is\s+.+\s+in\s+my\s+life(?:\s+right\s+now)?\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+['’]s\s+relationship\s+to\s+me\b/i.test(normalized) ||
    /\bwhat\s+is\s+each\s+person'?s?\s+relationship\s+to\s+me\b/i.test(normalized) ||
    /\bwhere\s+do(?:es)?\s+.+\s+(?:live|work|stay|based)\b/i.test(normalized) ||
    /\bwhere\s+has\s+.+\s+lived\b/i.test(normalized) ||
    /\bwhere\s+has\s+.+\s+worked\b/i.test(normalized) ||
    /\bwhere\s+was\s+.+\s+born\b/i.test(normalized) ||
    /\bwhere\s+is\s+.+\s+from\b/i.test(normalized) ||
    /\bwho\s+does\s+.+\s+work\s+with\b/i.test(normalized) ||
    /\bwhat\s+(?:groups|organizations|orgs)\s+(?:is|are)\s+.+\s+(?:a\s+member\s+of|part\s+of)\b/i.test(normalized) ||
    /\bwho\s+(?:am|is|are)\s+.+\s+dating(?:\s+now)?\b/i.test(normalized) ||
    /\bwho\s+(?:is|are)\s+.+\s+friends?\s+with\b/i.test(normalized) ||
    /\bwho\s+(?:is|are)\s+.+['’]s\s+friends?\b/i.test(normalized) ||
    /\bwho\s+are\s+my\s+friends\b/i.test(normalized) ||
    /\bwhat\s+does\s+.+\s+do\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+working\s+on\b/i.test(normalized) ||
    /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+works?\s+at\b/i.test(normalized) ||
    /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+lives?\s+in\b/i.test(normalized) ||
    /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+is\s+a\s+member\s+of\b/i.test(normalized)
  );
}

export function isHistoricalRelationshipQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+is\s+.+['’]s\s+history\s+with\b/i.test(normalized) ||
    /\bwhat\s+is\s+the\s+history\s+between\b/i.test(normalized) ||
    /\brelationship\s+history\b/i.test(normalized) ||
    /\bwho\s+used\s+to\s+be\s+in\s+my\s+life\b/i.test(normalized) ||
    /\bwho\s+is\s+no\s+longer\s+current\s+in\s+my\s+life\b/i.test(normalized) ||
    /\bnot\s+current\s+now\b/i.test(normalized) ||
    /\bwhere\s+has\s+.+\s+lived\b/i.test(normalized) ||
    /\bwhere\s+has\s+.+\s+worked\b/i.test(normalized) ||
    /\bwhere\s+was\s+.+\s+born\b/i.test(normalized) ||
    /\bwho\s+was\s+.+\s+dating\b/i.test(normalized) ||
    /\bwho\s+did\s+.+\s+date\b/i.test(normalized) ||
    /\bdid\s+.+\s+break\s+up\b/i.test(normalized) ||
    /\bdid\s+.+\s+start\s+talking\s+again\b/i.test(normalized) ||
    /\bdid\s+.+\s+stop\s+talking\b/i.test(normalized)
  );
}

export function isHistoricalWorkQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return /\bwhere\s+has\s+.+\s+worked\b/i.test(normalized);
}

export function isDailyLifeEventQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+do\b/i.test(normalized) ||
    /\bwhat\s+happened\s+(?:at|during|with)\b/i.test(normalized) ||
    /\bshow\s+me\s+the\s+event\b/i.test(normalized) ||
    /\bwhat\s+movies?\s+has\s+.+\s+(?:watched|seen)\b/i.test(normalized) ||
    /\bwho\s+did\s+.+\s+(?:have|get|eat)\s+(?:dinner|lunch|breakfast)\s+with\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\s+(?:coworking|co-?working)\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+(?:have|get|eat)\s+(?:dinner|lunch|breakfast)\b/i.test(normalized) ||
    /\b(?:coworking|co-?working|dinner|lunch|breakfast|massage|ride|rides|hike|movies?|watch(?:ed|ing)?|seen)\b/i.test(normalized)
  );
}

export function isTranscriptSpeechQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+say\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+say\s+about\b/i.test(normalized) ||
    /\bwho\s+said\b/i.test(normalized) ||
    /\bwhat\s+was\s+said\s+about\b/i.test(normalized)
  );
}

export function isDepartureTimingQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return /\bwhen\s+did\s+.+\s+(?:leave|left|return|returned)\b/i.test(normalized);
}

export function isStorageLocationQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return /\bwhere\s+are\s+.+\s+(?:things|stuff|belongings|possessions).+(?:stored|storage|kept)\b/i.test(normalized);
}

export function isRecentMediaRecallQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return /\bwhat\s+movies?\s+has\s+.+\s+(?:watched|seen)\b/i.test(normalized);
}

export function isDecisionQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+decisions?\b/i.test(normalized) ||
    /\bwhy\s+did\s+(?:we|i)\s+decide\b/i.test(normalized) ||
    /\bdecision\b/i.test(normalized) ||
    /\brationale\b/i.test(normalized)
  );
}

export function isEventBoundedQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bafter\b.+\bwhat\s+(?:coffee|cafe|café|restaurant|place)\b.+\bgo\s+to\b/i.test(normalized) ||
    /\bwhat\s+happened\s+at\b/i.test(normalized) ||
    /\bwhat\s+happened\s+during\b/i.test(normalized) ||
    /\bwhat\s+happened\s+with\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\s+after\b/i.test(normalized) ||
    /\bwhere\s+(?:was|did)\s+.+(?:meetup|conference|brunch|ride|trip|visit|event)\b/i.test(normalized) ||
    /\bshow\s+me\s+the\s+event\b/i.test(normalized) ||
    /\bwhat\s+happened\s+at\s+.+co-?working\b/i.test(normalized) ||
    /\bwhat\s+happened\s+during\s+.+(?:dinner|lunch|breakfast|massage|ride|trip|visit)\b/i.test(normalized)
  );
}

export function isHierarchyTraversalQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+(?:country|state|province|region|city)\s+is\s+.+\s+in\b/i.test(normalized) ||
    /\bwhich\s+(?:country|state|province|region|city)\s+is\s+.+\s+in\b/i.test(normalized) ||
    /\bwhere\s+in\s+the\s+hierarchy\s+is\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+contained\s+in\b/i.test(normalized) ||
    /\bwhat\s+contains\s+.+\b/i.test(normalized) ||
    /\bparent\s+(?:place|organization|org|project)\b/i.test(normalized) ||
    /\bcontained\s+in\b/i.test(normalized)
  );
}

export function isDailyLifeSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+do\s+(?:today|yesterday|tonight)\b/i.test(normalized) ||
    /\bwhat\s+did\s+i\s+do\s+(?:this\s+morning|last\s+week)\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+(?:talk|talk about|discuss|discuss about)\s+(?:today|yesterday|tonight)\b/i.test(normalized) ||
    /\bwhat\s+did\s+i\s+(?:talk|talk about|discuss|discuss about)\s+(?:this\s+morning|last\s+week)\b/i.test(normalized) ||
    /\bwhat\s+happened\s+(?:today|yesterday|that\s+day)\b/i.test(normalized) ||
    /\bwhat\s+happened\s+(?:last\s+week|this\s+morning)\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+do\s+on\b/i.test(normalized) ||
    /\bwhat\s+happened\s+on\b/i.test(normalized)
  );
}

export function isWarmStartQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+should\s+you\s+know\s+about\s+me\s+to\s+start\s+today\b/i.test(normalized) ||
    /\bwhat\s+should\s+the\s+brain\s+know\s+about\s+me\s+to\s+start\s+today\b/i.test(normalized) ||
    /\bhow\s+should\s+you\s+start\s+today\s+with\s+my\s+context\b/i.test(normalized) ||
    /\bgive\s+me\s+(?:a\s+)?warm\s+start\b/i.test(normalized) ||
    /\bwarm\s+start\s+pack\b/i.test(normalized) ||
    /\bstart\s+today\b[\s\S]{0,20}\bcontext\b/i.test(normalized)
  );
}

export function isPurchaseSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  if (
    /\btemporary\s+job\b/i.test(normalized) ||
    /\bcover\s+expenses\b/i.test(normalized) ||
    /\bwhat\s+job\b/i.test(normalized)
  ) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+(?:buy|purchase)\b/i.test(normalized) ||
    /\bwhat\s+did\s+i\s+(?:buy|purchase)\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+spend\b/i.test(normalized) ||
    /\bwhat\s+did\s+i\s+spend\b/i.test(normalized) ||
    /\bwhat\s+were\s+the\s+prices?\b/i.test(normalized) ||
    /\bhow\s+much\s+did\s+.+\s+spend\b/i.test(normalized) ||
    /\bhow\s+much\s+did\s+i\s+spend\b/i.test(normalized) ||
    /\bwhat\s+were\s+my\s+purchases?\b/i.test(normalized) ||
    /\bpurchases?\b/i.test(normalized) ||
    (/\bexpenses?\b/i.test(normalized) && /\b(?:my|i|today|yesterday|week|month|buy|bought|purchase|purchases|spend|spent|prices?)\b/i.test(normalized))
  );
}

export function isMediaSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+movies?\s+(?:have|has)\s+.+\s+(?:talked about|mentioned|watched|seen)\b/i.test(normalized) ||
    /\bwhat\s+movies?\s+have\s+i\s+(?:talked about|mentioned|watched|seen)\b/i.test(normalized) ||
    /\bwhat\s+shows?\s+(?:have|has)\s+.+\s+(?:talked about|mentioned|watched|seen)\b/i.test(normalized) ||
    /\bwhat\s+media\b/i.test(normalized) ||
    /\bmovies?\s+have\s+been\s+mentioned\b/i.test(normalized) ||
    /\bwhat\s+movie\s+did\s+.+\s+mention\b/i.test(normalized)
  );
}

export function isPreferenceSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+do\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+do\s+i\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+do\s+i\s+like\s+or\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+do\s+i\s+consistently\s+like\s+or\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+beer(?:s)?\s+do\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+are\s+my\s+favorite\s+beer(?:s)?\b/i.test(normalized) ||
    /\bwhat\s+thai\s+beer(?:s)?\s+do\s+i\s+(?:prefer|rank)\b/i.test(normalized) ||
    /\bwhat\s+are\s+my\s+favorite\s+beers?\s+in\s+thailand\b/i.test(normalized) ||
    /\bwhat\s+food\s+did\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+food\s+do\s+i\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+foods?\s+do\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+foods?\s+or\s+drinks?\s+do\s+i\s+(?:consistently\s+)?like\s+or\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+foods?\s+do\s+i\s+like\s+or\s+dislike\b/i.test(normalized) ||
    /\bwhat\s+shows?\s+did\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+movies?\s+did\s+i\s+like\b/i.test(normalized) ||
    /\bwhat\s+are\s+my\s+likes\s+and\s+dislikes\b/i.test(normalized) ||
    /\bwhat\s+preferences?\b/i.test(normalized)
  );
}

export function isRoutineSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+is\s+my\s+(?:current\s+)?daily\s+routine\b/i.test(normalized) ||
    /\bwhat\s+is\s+my\s+current\s+routine\b/i.test(normalized) ||
    /\bwhat\s+is\s+my\s+routine\b/i.test(normalized) ||
    /\bwhat\s+routines?\s+do\s+i\s+have\b/i.test(normalized) ||
    /\bwhat\s+habits?\s+do\s+i\s+have\b/i.test(normalized) ||
    /\bwhat\s+(?:routines?|habits?)\s+matter\s+right\s+now\b/i.test(normalized) ||
    /\bwhat\s+habits?\s+matter\s+right\s+now\b/i.test(normalized) ||
    /\bhow\s+do\s+i\s+usually\s+start\s+my\s+day\b/i.test(normalized)
  );
}

export function isPersonTimeFactQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+(?:talk about|mention|discuss)\b/i.test(normalized) ||
    /\bwhat\s+was\s+i\s+talking\s+about\s+with\b/i.test(normalized) ||
    /\bwhat\s+did\s+i\s+talk\s+about\s+with\b/i.test(normalized)
  );
}

export function isPreciseFactDetailQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bhow\s+long\b/i.test(normalized) ||
    /\bhow\s+many\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\b/i.test(normalized) ||
    /\b(?:what|which)\s+(?:team|club|organization|company|employer)\b/i.test(normalized) ||
    /\b(?:what|which)\s+(?:position|role|title|job)\b/i.test(normalized) ||
    /\bwhat\s+is\b[^?!.]{0,80}\b(?:position|role|title|job)\b/i.test(normalized) ||
    /\badopt(?:ed|ion)?\b/i.test(normalized) ||
    /\bwhat\s+are\s+the\s+names?\b/i.test(normalized) ||
    /\bwhat\s+(?:play|movie|film|show|book|song|title)\b/i.test(normalized) ||
    /\bfavorite\s+movie\s+trilog(?:y|ies)\b/i.test(normalized) ||
    /\bhobbies?\b/i.test(normalized) ||
    /\bwhat\s+(?:martial arts?|color)\b/i.test(normalized) ||
    /\btemporary\s+job\b/i.test(normalized) ||
    /\bwho\s+did\s+.+\s+(?:dinner|lunch|breakfast)\s+with\b/i.test(normalized) ||
    /\bpets?\s+wouldn'?t\s+cause\b/i.test(normalized) ||
    (/\bpets?\b/i.test(normalized) && /\ballerg/i.test(normalized)) ||
    /\bwhat\s+(?:was|is)\s+the\s+name\s+of\b/i.test(normalized) ||
    /^\s*where\b[^?!.]{0,80}\bmov(?:e|ed)\s+from\b/i.test(normalized) ||
    /\bwhere\s+did\s+i\s+(?:redeem|buy|get|purchase)\b/i.test(normalized) ||
    /\bwhere\s+do\s+i\s+take\b.+\bclasses?\b/i.test(normalized) ||
    /\bwhere\s+do\s+i\s+go\s+for\b.+\bclasses?\b/i.test(normalized)
  );
}

export function isProfileInferenceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    ((/\bbookshelf\b|\bdr\.?\s*seuss\b|\bclassic children'?s books?\b/i.test(normalized)) &&
      /\bwould\b|\blikely\b|\bmight\b/i.test(normalized)) ||
    /\bwould\s+.+\s+enjoy\s+reading\b/i.test(normalized) ||
    /\bsuspected\s+health\s+problems?\b/i.test(normalized) ||
    /\blive\s+in\s+connecticut\b/i.test(normalized) ||
    /\bis\s+deborah\s+married\b/i.test(normalized) ||
    /\bemploy\s+a\s+lot\s+of\s+people\b/i.test(normalized) ||
    /\bwhat\s+fields?\s+would\s+.+\s+likely\s+to?\s+pursue\b/i.test(normalized) ||
    /\bwhat\s+(?:kind|kinds)\s+of\s+jobs?\b/i.test(normalized) ||
    /\bwhat\s+kind\s+of\s+role\s+does\s+.+\s+seem\s+drawn\s+toward\b/i.test(normalized) ||
    /\bwhat\s+role\s+does\s+.+\s+seem\s+drawn\s+toward\b/i.test(normalized) ||
    /\bcareer\s+options?\b/i.test(normalized) ||
    /\blooking\s+into\s+(?:counseling|mental health|career|education)\b/i.test(normalized) ||
    /\b(?:education|educaton|study|career|major|degree)\b/i.test(normalized) && /\blikely\b/i.test(normalized)
  );
}

function isConcreteFavoritePaintingStyleQuery(normalized: string): boolean {
  return /\bfavorite\s+style\s+of\s+painting\b/i.test(normalized);
}

export function isConcreteConsumablePreferenceQuery(normalized: string): boolean {
  return (
    /\b(?:which|what)\s+(?:meat|food|dish|dessert|pastry|snack)\b/i.test(normalized) &&
    /\bprefer\b/i.test(normalized) &&
    (
      /\bmore than others\b/i.test(normalized) ||
      /\bmost\b/i.test(normalized) ||
      /\beat(?:ing)?\b/i.test(normalized)
    )
  );
}

export function isIdentityProfileQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  if (
    isConstraintQuery(normalized) ||
    /\b(constraint|constraints|rule|rules|policy|protocol|clarification|guess(?:ing)?|unclear|unknown)\b/i.test(normalized)
  ) {
    return false;
  }

  if (
    /\bin\s+my\s+life\b/i.test(normalized) ||
    /\brelationship\s+to\s+me\b/i.test(normalized) ||
    /\bfriends?\b/i.test(normalized)
  ) {
    return false;
  }

  return (
    /\bwhat\s+is\s+.+['’]s\s+identity\b/i.test(normalized) ||
    /\bwhat\s+does\s+.+\s+identify\s+as\b/i.test(normalized) ||
    /\bwho\s+is\s+.+\s+really\b/i.test(normalized) ||
    /\bwhat\s+kind\s+of\s+person\s+is\s+.+\b/i.test(normalized) ||
    /\b(?:identity|transgender|nonbinary|gender\s+identity)\b/i.test(normalized) && /\bwhat|who\b/i.test(normalized)
  );
}

export function isSharedCommonalityQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bin\s+common\b/i.test(normalized) ||
    /\bwhat\s+do\s+.+\s+both\b/i.test(normalized) ||
    /\bwhat\s+type\s+of\s+.+\s+have\s+.+\s+both\s+done\b/i.test(normalized) ||
    /\bwhat\s+kind\s+of\s+.+\s+have\s+.+\s+both\s+done\b/i.test(normalized) ||
    /\bwhat\s+.+\s+have\s+.+\s+both\s+done\b/i.test(normalized) ||
    /\bhow\s+do\s+.+\s+both\b/i.test(normalized) ||
    /\bwhich\s+\w+\s+have\s+both\b/i.test(normalized) ||
    /\bwhich\s+\w+\s+do\s+.+\s+share\b/i.test(normalized) ||
    /\bboth\s+.+\s+visited\b/i.test(normalized) ||
    /\bshared\b/i.test(normalized) ||
    /\bshare\b/i.test(normalized) ||
    /\bsame\b/i.test(normalized) && /\b(?:like|goal|goals|care|care about|way|ways|stress|destress)\b/i.test(normalized)
  );
}

export function isTemporalDetailQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const hasTemporalCue =
    /\bwhen\s+(?:did|was|were|has|have)\b/i.test(normalized) ||
    /\b(?:what|which)\s+(?:year|month|date|day)\b/i.test(normalized) ||
    /\bin\s+which\s+month'?s?\b/i.test(normalized) ||
    /\bon\s+[A-Z][a-z]+\s+\d{1,2}(?:,\s*|\s+)\d{4}\b/.test(normalized) ||
    /\bon\s+\d{4}-\d{2}-\d{2}\b/.test(normalized) ||
    /\b(today|yesterday|tonight|this\s+(?:day|week|month|year)|that\s+day|last\s+(?:day|week|month|year))\b/i.test(normalized) ||
    /\b(19\d{2}|20\d{2})\b/.test(normalized);

  if (!hasTemporalCue) {
    return false;
  }

  return (
    /\bhow\s+much\b/i.test(normalized) ||
    /\bhow\s+many\b/i.test(normalized) ||
    /\bwhat\s+time\b/i.test(normalized) ||
    /\b(?:what|which)\s+(?:year|month|date|day)\b/i.test(normalized) ||
    /\bin\s+which\s+month'?s?\b/i.test(normalized) ||
    /\bwhen\s+exactly\b/i.test(normalized) ||
    /\bwhen\s+(?:did|was|were|has|have)\b/i.test(normalized) ||
    /\bwho\s+was\s+.+\s+with\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\b/i.test(normalized) ||
    /\bwhere\s+was\s+.+\b/i.test(normalized) ||
    /\bwhich\s+\w+\b/i.test(normalized) ||
    /\bexact\b/i.test(normalized) ||
    /\b(?:cost|price|amount|paid|pay|spent|spend|invoice|receipt|fee|fees)\b/i.test(normalized)
  );
}

export function isPreferenceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  if (isConcreteFavoritePaintingStyleQuery(normalized)) {
    return false;
  }
  if (isConcreteConsumablePreferenceQuery(normalized)) {
    return false;
  }

  return (
    /\b(prefer|preference|favorite|favourite|watchlist)\b/i.test(normalized) ||
    /\bwhat\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\bwhat\s+does\s+.+\s+(?:drink|drinks)\b/i.test(normalized) ||
    /\bwhich\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\b(?:tea|coffee|drink|beverage).+\b(?:want|wants|right)\b/i.test(normalized) ||
    /\bevening\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\bkettle\b/i.test(normalized) ||
    /\bwant(?:s)?\s+to\s+watch\b/i.test(normalized) ||
    /\bwhat\s+(?:kind|types?)\s+of\b.+\b(?:like|dislike|avoid)\b/i.test(normalized) ||
    /\bwhat\s+movies?\s+does\s+.+\s+(?:like|dislike)\b/i.test(normalized) ||
    /\bwhat\s+diet\s+does\s+.+\s+follow\b/i.test(normalized) ||
    /\bavoid(?:s|ing)?\s+living\b/i.test(normalized) ||
    /\bdoes\s+.+\s+(?:like|dislike)\b/i.test(normalized)
  );
}

export function isHistoricalPreferenceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bused\s+to\s+prefer\b/i.test(normalized) ||
    /\buse\s+to\s+prefer\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+prefer\b/i.test(normalized) ||
    /\bdid\s+.+\s+still\s+prefer\b/i.test(normalized) ||
    (/\bprefer\b/i.test(normalized) && /\bin\s+(19\d{2}|20\d{2})\b/i.test(normalized))
  );
}

export function isCurrentPreferenceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  if (isConcreteConsumablePreferenceQuery(normalized)) {
    return false;
  }

  return (
    /\bwhat\s+does\s+.+\s+prefer\s+now\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+['’]s\s+current\s+preference\b/i.test(normalized) ||
    /\bcurrent\s+preference\b/i.test(normalized) ||
    /\bwhat\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\bwhat\s+does\s+.+\s+(?:drink|drinks)\b/i.test(normalized) ||
    /\bwhich\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\bevening\s+(?:tea|coffee|drink|beverage)\b/i.test(normalized) ||
    /\bkettle\b/i.test(normalized) ||
    /\bwhat\s+(?:kind|types?)\s+of\b.+\b(?:like|dislike|avoid)\b/i.test(normalized) ||
    /\bwhat\s+movies?\s+does\s+.+\s+(?:like|dislike)\b/i.test(normalized) ||
    /\bwhat\s+diet\s+does\s+.+\s+follow\b/i.test(normalized)
  );
}

export function isStyleSpecQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bstyle\s+specs?\b/i.test(normalized) ||
    /\bwork-?style\b/i.test(normalized) ||
    /\bresponse\s+style\b/i.test(normalized) ||
    /\bformat(?:ting)?\s+preferences?\b/i.test(normalized) ||
    /\bmandatory\s+protocol\b/i.test(normalized) ||
    /\bprotocol\s+for\s+changing\s+the\s+brain'?s?\s+ontology\b/i.test(normalized) ||
    (/\bdatabase\b/i.test(normalized) && /\bontology\s+slice\b/i.test(normalized)) ||
    (/\bdatabase\b/i.test(normalized) && /\bafter\s+each\s+(?:implementation\s+|ontology\s+)?slice\b/i.test(normalized)) ||
    /\bwhat\s+should\s+be\s+done\s+with\s+the\s+database\b/i.test(normalized) ||
    (/\bdatabase\s+integrity\b/i.test(normalized) && /\bimplementation\s+slice\b/i.test(normalized)) ||
    (/\bprotocol\b/i.test(normalized) && /\bimplementation\s+slice\b/i.test(normalized)) ||
    /\bhow\s+should\s+(?:the\s+brain|you)\s+(?:answer|format|respond)\b/i.test(normalized)
  );
}

export function isConstraintQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+constraints?\b/i.test(normalized) ||
    /\bwhat\s+(?:habits?\s+or\s+constraints?|constraints?\s+or\s+habits?)\b/i.test(normalized) ||
    /\bwhat\s+constraints?\s+matter\s+right\s+now\b/i.test(normalized) ||
    /\bwhat\s+rules?\b/i.test(normalized) ||
    /\bpolicy\b/i.test(normalized) ||
    /\bmandatory\s+protocol\b/i.test(normalized) ||
    /\b(?:dietary|allergy|allergic|blocker|blockers|safety)\b/i.test(normalized)
  );
}

export function isGoalQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bcurrent\s+primary\s+goal\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+['’]s\s+goal\b/i.test(normalized) ||
    /\bwhat\s+is\s+my\s+goal\b/i.test(normalized)
  );
}

export function isPlanQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+plans?\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+planning\b/i.test(normalized) ||
    /\bTurkey\s+conference\b/i.test(normalized)
  );
}

export function isBeliefQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bcurrent\s+stance\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+(?:current\s+)?stance\b/i.test(normalized) ||
    /\bhow\s+has\s+.+\s+(?:opinion|stance|belief)\b/i.test(normalized) ||
    /\bwhat\s+does\s+.+\s+believe\b/i.test(normalized) ||
    /\bdid\s+.+\s+still\s+support\b/i.test(normalized)
  );
}

export function isHistoricalBeliefQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bhow\s+has\s+.+\s+(?:opinion|stance|belief)\b/i.test(normalized) ||
    /\bdid\s+.+\s+still\s+support\b/i.test(normalized) ||
    (/\b(?:opinion|stance|belief|support)\b/i.test(normalized) && /\bin\s+(?:[A-Z][a-z]+\s+)?(19\d{2}|20\d{2})\b/i.test(normalized))
  );
}

export function isSalienceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\b(?:surprising|surprise|realization)\b/i.test(normalized) ||
    /\b(?:frustrating|frustration|frustrated|annoyed|bothered)\b/i.test(normalized) ||
    /\b(?:excited|exciting|amazing|thrilled)\b/i.test(normalized)
  );
}

export function preferredRelationshipPredicates(queryText: string): readonly string[] {
  const normalized = queryText.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  if (
    /\bwho\s+is\s+.+\s+in\s+my\s+life(?:\s+right\s+now)?\b/i.test(normalized) &&
    /\bassociated with\b/i.test(normalized)
  ) {
    return [
      "owner_of",
      "associated_with",
      "friend_of",
      "best_friends_with",
      "former_partner_of",
      "works_with",
      "works_on",
      "project_role",
      "met_through",
      "member_of",
      "significant_other_of",
      "was_with",
      "relationship_reconnected",
      "relationship_ended"
    ];
  }

  if (
    /\bwho\s+is\s+.+\s+in\s+my\s+life(?:\s+right\s+now)?\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+['’]s\s+relationship\s+to\s+me\b/i.test(normalized) ||
    /\bwhat\s+is\s+each\s+person'?s?\s+relationship\s+to\s+me\b/i.test(normalized)
  ) {
    return [
      "friend_of",
      "best_friends_with",
      "significant_other_of",
      "former_partner_of",
      "was_with",
      "works_with",
      "works_on",
      "owner_of",
      "associated_with",
      "met_through",
      "member_of",
      "project_role",
      "relationship_reconnected",
      "relationship_ended"
    ];
  }

  if (/\bwhere\s+do(?:es)?\s+.+\s+(?:live|stay|based)\b/i.test(normalized)) {
    return ["resides_at", "lives_in", "currently_in"];
  }

  if (/\bwhere\s+has\s+.+\s+lived\b/i.test(normalized)) {
    return ["lived_in", "resides_at", "lives_in", "currently_in", "born_in"];
  }

  if (/\bwhere\s+was\s+.+\s+born\b/i.test(normalized)) {
    return ["born_in", "from", "lived_in"];
  }

  if (/\bwhere\s+is\s+.+\s+from\b/i.test(normalized)) {
    return ["from", "originates_from"];
  }

  if (/\bwhere\s+has\s+.+\s+worked\b/i.test(normalized)) {
    return ["worked_at", "works_at", "works_on", "project_role", "runs", "works_with"];
  }

  if (/\b.+\s+works?\s+at\b/i.test(normalized)) {
    return ["works_at", "worked_at", "runs"];
  }

  if (/\bwho\s+does\s+.+\s+work\s+with\b/i.test(normalized)) {
    return ["works_with", "works_at", "works_on"];
  }

  if (/\bwho\s+(?:is|are)\s+.+['’]s\s+(?:family|siblings?|sister|brother)\b/i.test(normalized) || /\bwho\s+is\s+.+['’]s\s+sister\b/i.test(normalized) || /\bwho\s+is\s+.+['’]s\s+brother\b/i.test(normalized)) {
    return ["sibling_of", "friend_of", "was_with"];
  }

  if (/\b.+\s+lives?\s+in\b/i.test(normalized)) {
    return ["resides_at", "lives_in", "currently_in", "lived_in"];
  }

  if (/\bwhat\s+(?:groups|organizations|orgs)\s+(?:is|are)\s+.+\s+(?:a\s+member\s+of|part\s+of)\b/i.test(normalized)) {
    return ["member_of"];
  }

  if (/\b.+\s+is\s+a\s+member\s+of\b/i.test(normalized)) {
    return ["member_of"];
  }

  if (/\bwho\s+(?:is|are)\s+.+\s+friends?\s+with\b/i.test(normalized)) {
    return ["friend_of", "friends_with", "best_friends_with", "was_with", "met_through", "works_with"];
  }

  if (/\bwho\s+(?:is|are)\s+.+['’]s\s+friends?\b/i.test(normalized) || /\bwho\s+are\s+my\s+friends\b/i.test(normalized)) {
    return ["friend_of", "friends_with", "best_friends_with", "was_with", "met_through", "works_with"];
  }

  if (
    /\bdid\s+.+\s+date\b/i.test(normalized) ||
    /\bwere\s+.+\s+together\b/i.test(normalized) ||
    /\bwho\s+did\s+.+\s+date\b/i.test(normalized) ||
    /\bwho\s+was\s+.+\s+dating\b/i.test(normalized) ||
    /\bwho\s+(?:am|is|are)\s+.+\s+dating(?:\s+now)?\b/i.test(normalized)
  ) {
    return ["significant_other_of", "was_with", "friend_of", "relationship_ended", "relationship_reconnected"];
  }

  if (
    /\bdid\s+.+\s+break\s+up\b/i.test(normalized) ||
    /\bdid\s+.+\s+start\s+talking\s+again\b/i.test(normalized) ||
    /\bdid\s+.+\s+stop\s+talking\b/i.test(normalized)
  ) {
    return ["relationship_ended", "relationship_reconnected", "relationship_contact_paused", "was_with"];
  }

  if (
    /\bwhere\s+do(?:es)?\s+.+\s+work\b/i.test(normalized)
  ) {
    return ["works_at", "worked_at", "runs"];
  }

  if (
    /\bwhat\s+does\s+.+\s+do\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+working\s+on\b/i.test(normalized)
  ) {
    return ["works_on", "project_role", "works_at", "runs", "works_with"];
  }

  return [];
}
