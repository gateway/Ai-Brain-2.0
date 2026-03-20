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
    /\bwhere\s+has\s+.+\s+lived\b/i.test(normalized) ||
    /\bwhere\s+has\s+.+\s+worked\b/i.test(normalized) ||
    /\bwhere\s+was\s+.+\s+born\b/i.test(normalized) ||
    /\bwho\s+was\s+.+\s+dating\b/i.test(normalized) ||
    /\bwho\s+did\s+.+\s+date\b/i.test(normalized)
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
    /\bwho\s+did\s+.+\s+(?:have|get|eat)\s+(?:dinner|lunch|breakfast)\s+with\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+go\s+(?:coworking|co-?working)\b/i.test(normalized) ||
    /\bwhere\s+did\s+.+\s+(?:have|get|eat)\s+(?:dinner|lunch|breakfast)\b/i.test(normalized) ||
    /\b(?:coworking|co-?working|dinner|lunch|breakfast|massage|ride|rides|hike|movie)\b/i.test(normalized)
  );
}

export function isEventBoundedQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+happened\s+at\b/i.test(normalized) ||
    /\bwhat\s+happened\s+during\b/i.test(normalized) ||
    /\bwhat\s+happened\s+with\b/i.test(normalized) ||
    /\bshow\s+me\s+the\s+event\b/i.test(normalized) ||
    /\bwhat\s+happened\s+at\s+.+co-?working\b/i.test(normalized) ||
    /\bwhat\s+happened\s+during\s+.+(?:dinner|lunch|breakfast|massage|ride|trip|visit)\b/i.test(normalized)
  );
}

export function isDailyLifeSummaryQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bwhat\s+did\s+.+\s+do\s+(?:today|yesterday|tonight)\b/i.test(normalized) ||
    /\bwhat\s+happened\s+(?:today|yesterday|that\s+day)\b/i.test(normalized) ||
    /\bwhat\s+did\s+.+\s+do\s+on\b/i.test(normalized) ||
    /\bwhat\s+happened\s+on\b/i.test(normalized)
  );
}

export function isTemporalDetailQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  const hasTemporalCue =
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
    /\bwhen\s+exactly\b/i.test(normalized) ||
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

  return /\b(prefer|preference|favorite|favourite)\b/i.test(normalized);
}

export function isHistoricalPreferenceQuery(queryText: string): boolean {
  const normalized = queryText.trim();
  if (!normalized) {
    return false;
  }

  return (
    /\bused\s+to\s+prefer\b/i.test(normalized) ||
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

  return (
    /\bwhat\s+does\s+.+\s+prefer\s+now\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+['’]s\s+current\s+preference\b/i.test(normalized) ||
    /\bcurrent\s+preference\b/i.test(normalized)
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
    (/\bdatabase\s+integrity\b/i.test(normalized) && /\bimplementation\s+slice\b/i.test(normalized)) ||
    (/\bprotocol\b/i.test(normalized) && /\bimplementation\s+slice\b/i.test(normalized)) ||
    /\bhow\s+should\s+(?:the\s+brain|you)\s+(?:answer|format|respond)\b/i.test(normalized)
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
    return ["worked_at", "works_at", "works_on", "project_role", "member_of", "runs", "works_with"];
  }

  if (/\b.+\s+works?\s+at\b/i.test(normalized)) {
    return ["works_at", "worked_at", "runs"];
  }

  if (/\bwho\s+does\s+.+\s+work\s+with\b/i.test(normalized)) {
    return ["works_with", "works_at", "works_on", "member_of"];
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
    return ["works_at", "worked_at", "runs", "member_of"];
  }

  if (
    /\bwhat\s+does\s+.+\s+do\b/i.test(normalized) ||
    /\bwhat\s+is\s+.+\s+working\s+on\b/i.test(normalized)
  ) {
    return ["works_on", "project_role", "works_at", "member_of", "runs", "works_with"];
  }

  return [];
}
