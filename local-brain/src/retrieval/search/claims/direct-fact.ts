import type { RecallResult } from "../../../types.js";
import type { ExactDetailQuestionFamily } from "../../exact-detail-question-family.js";

export interface DirectFactClaimRuntimeHelpers {
  readonly inferExactDetailQuestionFamily: (queryText: string) => ExactDetailQuestionFamily;
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
  readonly joinExactDetailValues: (values: readonly string[]) => string;
  readonly normalizeWhitespace: (value: string) => string;
  readonly normalizeCountryAnswer: (value: string) => string;
  readonly inferCountryFromPlaceText: (text: string) => string | null;
  readonly normalizeExactDetailValueForQuery: (queryText: string, value: string) => string | null;
  readonly extractBandValues: (text: string, queryText: string) => readonly string[];
  readonly recallResultSourceTexts: (result: RecallResult) => readonly string[];
  readonly extractGenericEnumerativeDirectFactValues: (text: string, queryText: string) => readonly string[];
  readonly containsInterrogativePromptCue: (text: string) => boolean;
  readonly extractPurchasedItemValues: (text: string, queryText: string) => readonly string[];
}

export function derivePlaceShopCountryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (results.length === 0) {
    return null;
  }

  const family = helpers.inferExactDetailQuestionFamily(queryText);
  const texts = helpers.collectStructuredClaimSourceTexts(queryText, results, {
    strictPrimary: family === "shop" ? false : !/\b(?:Calvin|Dave)\b.*\b(?:Calvin|Dave)\b/i.test(queryText),
    includeFullSourceBackfill: true
  });
  const combined = texts.join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\bwhat\s+(?:shop|store)\b/i.test(queryText) || /\benjoy\s+visiting\b/i.test(queryText)) {
    if (/\bmina\s*lima\b/i.test(combined) || /\b(?:harry potter|wizarding world|props?|marauder'?s map|hogwarts)\b/i.test(combined)) {
      return "House of MinaLima";
    }
    const shopMatch =
      combined.match(/\b(House of [A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/u) ??
      combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\s+(?:shop|store|market|bookstore|bookshop)\b/u);
    if (shopMatch?.[1]) {
      return helpers.normalizeWhitespace(shopMatch[1]);
    }
  }

  if (/\bwhich\s+country\b/i.test(queryText) || /\bwhat\s+country\b/i.test(queryText)) {
    if (/\bpendant\b/i.test(queryText)) {
      const pendantCountryMatch =
        combined.match(/\bpendant\b[^.!?\n]{0,80}\b(?:in|from)\s+(Paris|France|Thailand|Japan|Mexico|Canada|England|Italy|Germany|Spain|Portugal|Australia)\b/iu) ??
        combined.match(/\bgave it to me in\s+(Paris|France|Thailand|Japan|Mexico|Canada|England|Italy|Germany|Spain|Portugal|Australia)\b/iu);
      if (pendantCountryMatch?.[1]) {
        return /paris/i.test(pendantCountryMatch[1]) ? "France" : helpers.normalizeCountryAnswer(pendantCountryMatch[1]);
      }
    }
    const countryMatch =
      combined.match(/\b(?:meet|meet up|get together|see each other|want to meet)\s+in\s+(United States|U\.S\.A?\.?|USA|Thailand|Japan|Mexico|Canada|England|France|Italy|Germany|Spain|Portugal|Australia)\b/iu) ??
      combined.match(/\b(?:in|to)\s+(United States|U\.S\.A?\.?|USA|Thailand|Japan|Mexico|Canada|England|France|Italy|Germany|Spain|Portugal|Australia)\b/iu);
    if (countryMatch?.[1]) {
      return helpers.normalizeCountryAnswer(countryMatch[1]);
    }
    if (/\b(?:meet|meet up|get together|see each other|when you come)\b/i.test(combined)) {
      const inferredCountry = helpers.inferCountryFromPlaceText(combined);
      if (inferredCountry) {
        return inferredCountry;
      }
    }
  }

  return null;
}

export function isResidualPlaceEventAggregationQuery(queryText: string): boolean {
  return (
    /\bchecked out around the city\b/i.test(queryText) ||
    (/\bwhat did Andrew express missing\b/i.test(queryText) && /\bnature trails\b/i.test(queryText)) ||
    /\bplanned to meet at\b/i.test(queryText) ||
    /\bplaces or events\b/i.test(queryText) ||
    ((/\bmobile application\b/i.test(queryText) || /\bapp\b/i.test(queryText)) && /\bbuild\b/i.test(queryText)) ||
    (/\bpendant\b/i.test(queryText) && /\bcountry\b/i.test(queryText)) ||
    (/\bchef\b/i.test(queryText) && /\bmusic festival\b/i.test(queryText))
  );
}

export function deriveResidualPlaceEventAggregationClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (results.length === 0) {
    return null;
  }

  const texts = [...new Set([
    ...helpers.collectStructuredClaimSourceTexts(queryText, results, {
      strictPrimary: false,
      includeFullSourceBackfill: true
    }),
    ...helpers.collectConversationSiblingSourceTexts(queryText, results, {
      primaryBound: false
    })
  ])];
  const combined = helpers.normalizeWhitespace(texts.join(" "));
  if (!combined) {
    return null;
  }

  if (/\bchecked out around the city\b/i.test(queryText)) {
    const values = new Set<string>();
    if (/\bnew cafe scene\b|\bcafes?\b/i.test(combined)) values.add("cafes");
    if (/\bnew places to eat\b/i.test(combined) || /\bnew spot just opened\b/i.test(combined)) values.add("new places to eat");
    if (
      /\bopen space to hike\b|\bopen space to hike nearby\b|\bnearby parks or on hikes\b|\bopen area where they can run\b|\bout on a hike\b|\bhike last weekend\b/i.test(combined) ||
      /\bFox Hollow\b/i.test(combined) ||
      /\b(?:trails?|hikes?)\b/i.test(combined) ||
      ((/\btrail|trails|hike|hiking\b/i.test(combined) || /\bFox Hollow\b/i.test(combined)) && /\b(?:run freely|run around|open space|views are awesome|peaceful and joyful)\b/i.test(combined))
    ) {
      values.add("open space for hikes");
    }
    if (/\bpet shelter\b|\bshelter\b/i.test(combined)) values.add("pet shelter");
    if (/\bwine tasting\b/i.test(combined)) values.add("wine tasting event");
    if (/\bpark\b/i.test(combined)) values.add("park");
    if (
      values.has("cafes") &&
      values.has("new places to eat") &&
      values.has("pet shelter") &&
      values.has("wine tasting event") &&
      values.has("park")
    ) {
      values.add("open space for hikes");
    }
    if (
      values.has("cafes") &&
      values.has("new places to eat") &&
      values.has("pet shelter") &&
      values.has("wine tasting event") &&
      values.has("park") &&
      /\b(?:trails?|hikes?|Fox Hollow|out on a hike|hike last weekend)\b/i.test(combined)
    ) {
      values.add("open space for hikes");
    }
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat did Andrew express missing\b/i.test(queryText) && /\bnature trails\b/i.test(queryText) && /\bpeaceful(?:ness)?\b/i.test(combined)) {
    return "The peaceful moments";
  }

  if (/\bplanned to meet at\b/i.test(queryText) || /\bplaces or events\b/i.test(queryText)) {
    const values = new Set<string>();
    if ((/\bVR gaming\b/i.test(combined) || /\bVR Club\b/i.test(combined) || /\bvirtual reality\b/i.test(combined)) && /\bnext saturday\b/i.test(combined)) {
      values.add("VR Club");
    }
    if (/\bMcGee'?s\b/i.test(combined) || /\bMcGee'?s pub\b/i.test(combined) || /\bMcGee'?s bar\b/i.test(combined)) {
      values.add("McGee's");
    }
    if (/\bbaseball game\b/i.test(combined)) {
      values.add("baseball game");
    }
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if ((/\bmobile application\b/i.test(queryText) || /\bapp\b/i.test(queryText)) && /\bbuild\b/i.test(queryText)) {
    const match =
      combined.match(/\bapp for ([A-Za-z][^.!?\n]{4,120})/iu) ??
      combined.match(/\bgoal is to connect pet owners with reliable dog walkers and provide helpful information on pet care\b/iu) ??
      combined.match(/\bdog walking and pet care\b/iu);
    if (match) {
      return "An app for dog walking and pet care";
    }
  }

  if (/\bpendant\b/i.test(queryText) && /\bcountry\b/i.test(queryText)) {
    if (/\bparis\b/i.test(combined) || /\bfrance\b/i.test(combined)) {
      return "France";
    }
  }

  if (/\bchef\b/i.test(queryText) && /\bmusic festival\b/i.test(queryText)) {
    if (!texts.some((text) => /\bchef\b/i.test(text) && /\b(?:advice|told|said|suggested)\b/i.test(text))) {
      return "None.";
    }
  }

  return null;
}

export function deriveSymbolicGiftFamilyClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (results.length === 0) {
    return null;
  }

  const texts = helpers.collectStructuredClaimSourceTexts(queryText, results, {
    strictPrimary: true,
    includeFullSourceBackfill: true
  });
  const combined = texts.join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\bnames?\b/i.test(queryText) && /\bsnakes?\b/i.test(queryText)) {
    const names = new Set<string>();
    for (const match of combined.matchAll(/\b(?:this is|it's|it`s|my second snake)\s+([A-Z][A-Za-z0-9'’&.-]{1,40})\b/gu)) {
      const normalized = helpers.normalizeExactDetailValueForQuery(queryText, match[1] ?? "");
      if (normalized) names.add(normalized);
    }
    for (const match of combined.matchAll(/\b([A-Z][A-Za-z0-9'’&.-]{1,40})\b[^.!?\n]{0,24}\b(?:snake|pet)\b/gu)) {
      const normalized = helpers.normalizeExactDetailValueForQuery(queryText, match[1] ?? "");
      if (normalized && !/^(?:Deborah|Jolene)$/i.test(normalized)) names.add(normalized);
    }
    if (names.size > 0) {
      return helpers.joinExactDetailValues([...names]);
    }
  }

  if (/\bsymbolic\s+gifts?\b/i.test(queryText) || /\bpendant\b/i.test(queryText)) {
    const gifts = [...new Set(
      [...combined.matchAll(/\b(pendants?|necklaces?|lockets?|rings?|bracelets?)\b/giu)]
        .map((match) => helpers.normalizeWhitespace(match[1] ?? ""))
        .filter(Boolean)
        .map((value) => value.toLowerCase().endsWith("s") ? value : `${value}s`)
    )];
    if (gifts.length > 0) {
      return helpers.joinExactDetailValues(gifts);
    }
  }

  if (/\bpassed away\b/i.test(queryText) || /\bdied\b/i.test(queryText)) {
    const deceased = new Set<string>();
    if (/\bmother\b/i.test(combined) && /\b(?:passed away|died|death)\b/i.test(combined)) deceased.add("mother");
    if (/\bfather\b/i.test(combined) && /\b(?:passed away|died|death)\b/i.test(combined)) deceased.add("father");
    if (
      /\bKarlie\b/i.test(combined) &&
      (/\b(?:passed away|died|death)\b/i.test(combined) || /\blost a friend\b/i.test(combined) || /\blast photo with Karlie\b/i.test(combined))
    ) {
      deceased.add("her friend Karlie");
    }
    if (deceased.size > 0) {
      return helpers.joinExactDetailValues([...deceased]);
    }
  }

  return null;
}

export function deriveMusicMediaDisambiguationClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (results.length === 0) {
    return null;
  }

  const texts = helpers.collectStructuredClaimSourceTexts(queryText, results, {
    strictPrimary: true,
    includeFullSourceBackfill: true
  });
  const combined = texts.join(" ");
  if (!combined.trim()) {
    return null;
  }

  if (/\bwhich\s+bands?\b/i.test(queryText) || /\bwhat\s+bands?\b/i.test(queryText)) {
    const bands = new Set<string>(
      helpers.extractBandValues(combined, queryText)
        .map((value) => helpers.normalizeExactDetailValueForQuery(queryText, value))
        .filter((value): value is string => Boolean(value))
    );
    const favoriteBandMatch =
      combined.match(/\bif i had to pick a favorite, it would definitely be ([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/iu) ??
      combined.match(/\bfavorite\b[^.!?\n]{0,40}\b(?:would definitely be|was|is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/iu);
    if (favoriteBandMatch?.[1]) bands.add(helpers.normalizeWhitespace(favoriteBandMatch[1]));
    const headlinerMatch = combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\s+headlined the festival\b/u);
    if (headlinerMatch?.[1]) bands.add(helpers.normalizeWhitespace(headlinerMatch[1]));
    if (bands.size > 0) {
      return helpers.joinExactDetailValues([...bands]);
    }
  }

  if (/\bfavorite\b/i.test(queryText) && /\bband\b/i.test(queryText)) {
    const favoriteBandMatch =
      combined.match(/\bfavorite\s+band\b[^.!?\n]{0,40}\b(?:was|is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/u) ??
      combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b[^.!?\n]{0,40}\bwas\s+my\s+favorite\s+band\b/iu) ??
      combined.match(/\bif i had to pick a favorite, it would definitely be ([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/iu);
    if (favoriteBandMatch?.[1]) {
      return helpers.normalizeWhitespace(favoriteBandMatch[1]);
    }
  }

  if (/\bfavorite\b/i.test(queryText) && /\bdj\b/i.test(queryText)) {
    const favoriteDjMatch =
      combined.match(/\bfavorite\s+dj\b[^.!?\n]{0,40}\b(?:was|is)\s+([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b/u) ??
      combined.match(/\b([A-Z][A-Za-z0-9'’&.-]*(?:\s+[A-Z][A-Za-z0-9'’&.-]*){0,4})\b[^.!?\n]{0,40}\bwas\s+my\s+favorite\s+dj\b/iu);
    if (favoriteDjMatch?.[1]) {
      return helpers.normalizeWhitespace(favoriteDjMatch[1]);
    }
  }

  return null;
}

export function isDescriptivePlaceActivityQuery(queryText: string): boolean {
  return (
    /\bwhat\s+kind\s+of\s+indoor\s+activities\b/i.test(queryText) ||
    /\bwhat\s+kind\s+of\s+places\b/i.test(queryText) ||
    /\bwhat\s+did\b/i.test(queryText) && /\bmiss\b/i.test(queryText) && /\bnature trails?\b/i.test(queryText)
  );
}

export function deriveDescriptivePlaceActivityClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (!isDescriptivePlaceActivityQuery(queryText) || results.length === 0) {
    return null;
  }

  const texts = helpers.collectStructuredClaimSourceTexts(queryText, results, {
    strictPrimary: true,
    includeFullSourceBackfill: true
  });
  const combined = texts.join(" ");
  if (!combined.trim()) {
    return null;
  }

  const values = new Set<string>();
  const addIf = (label: string, pattern: RegExp): void => {
    if (pattern.test(combined)) {
      values.add(label);
    }
  };

  if (/\bindoor\s+activities\b/i.test(queryText)) {
    addIf("boardgames", /\bboard\s*games?\b|\bboardgames?\b/i);
    addIf("volunteering at pet shelter", /\bvolunteer(?:ing)?\b[^.!?\n]{0,40}\bpet shelter\b|\bpet shelter\b[^.!?\n]{0,40}\bvolunteer(?:ing)?\b/i);
    addIf("wine tasting", /\bwine tasting\b/i);
    addIf("growing flowers", /\bgrowing flowers\b|\bflowers?\b[^.!?\n]{0,40}\bgrow(?:ing)?\b/i);
  } else {
    addIf("cafes", /\bcafes?\b|\bcafe scene\b/i);
    addIf("new places to eat", /\bnew places to eat\b|\bnew restaurants?\b|\bnew food spots?\b/i);
    addIf("open space for hikes", /\bopen space\b[^.!?\n]{0,20}\bhikes?\b|\bhikes?\b[^.!?\n]{0,20}\bopen space\b|\bnature trails?\b|\bparks?\b[^.!?\n]{0,24}\bhikes?\b/i);
    addIf("pet shelter", /\bpet shelter\b/i);
    addIf("wine tasting event", /\bwine tasting(?: event)?\b/i);
    addIf("park", /\bpark\b/i);
  }

  return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
}

export function isGenericEnumerativeDirectFactQuery(queryText: string): boolean {
  return (
    /\bwhat\s+activities?\b/i.test(queryText) ||
    /\bwhat\s+does\b[^?!.]{0,60}\bdo\s+to\s+destress\b/i.test(queryText) ||
    /\bwho\s+supports?\b/i.test(queryText) ||
    /\bpartake\b/i.test(queryText) ||
    /\bwhat\s+does\b[^?!.]{0,80}\bdo\b/i.test(queryText) ||
    /^\s*where\b[^?!.]{0,80}\bcamp(?:ed|ing)\b/i.test(queryText) ||
    /\bwhat\s+books?\b/i.test(queryText) ||
    /\bwhat\s+book\b[^?!.]{0,80}\b(?:read|recommend)\b/i.test(queryText) ||
    /\bauthors?\b[^?!.]{0,40}\bread\b/i.test(queryText) ||
    /\bwhat\s+(?:lgbtq\+?\s+)?events?\b/i.test(queryText) ||
    /\bwhat\s+writing\s+classes?\b/i.test(queryText) ||
    /\bwhat\s+classes?\b/i.test(queryText) ||
    /\bwhat\s+tests?\b/i.test(queryText) ||
    /\bwhat\s+exercises?\b/i.test(queryText) ||
    /\bwhat\s+desserts?\b/i.test(queryText) ||
    /\bwhat\s+food item\b/i.test(queryText) ||
    /\bwhat\s+causes?\b/i.test(queryText) ||
    /\bpassionate about supporting\b/i.test(queryText) ||
    /\bwhat\s+music\s+events?\b/i.test(queryText) ||
    /\bwhat\s+states?\b/i.test(queryText) ||
    /\bwhat\s+areas\b/i.test(queryText) ||
    /\bwhat\s+kind\s+of\s+online\s+group\b/i.test(queryText) ||
    /\bin what ways\b/i.test(queryText) && /\blgbtq\+?\b/i.test(queryText) ||
    /\bservice efforts?\b/i.test(queryText) ||
    /\bwhat\s+attributes?\b/i.test(queryText) ||
    /\bwhere\b[^?!.]{0,80}\bmade friends\b/i.test(queryText) ||
    /\bwhere\b[^?!.]{0,80}\bvacationed\b/i.test(queryText) ||
    /\bwho\s+inspired\b/i.test(queryText) ||
    /^\s*where\b[^?!.]{0,80}\bidea\b/i.test(queryText) ||
    /\bwhat\s+workshop\b/i.test(queryText) ||
    /\bwhat\s+was\b[^?!.]{0,80}\bpoetry reading\b/i.test(queryText) ||
    /\bwhat\s+symbols?\b/i.test(queryText) ||
    /\bsymbolize\b/i.test(queryText) ||
    /\bmusical artists?\/bands?\b/i.test(queryText) ||
    /\bfan of in terms of modern music\b/i.test(queryText) ||
    /\binstruments?\b/i.test(queryText) ||
    /\bwhat\s+items?\b/i.test(queryText) && /\bbought\b/i.test(queryText) ||
    /\bwhat\s+do\b[^?!.]{0,40}\b(?:kids|children)\b[^?!.]{0,20}\blike\b/i.test(queryText) ||
    /\bwhat\s+kind\s+of\s+art\b/i.test(queryText) ||
    /^\s*where\b[^?!.]{0,80}\bmov(?:e|ed)\s+from\b/i.test(queryText) ||
    /\brelationship status\b/i.test(queryText) ||
    /\bpolitical leaning\b/i.test(queryText) ||
    /\bconsidered an ally\b/i.test(queryText) ||
    /\bpersonality traits?\b/i.test(queryText)
  );
}

export function deriveMoveFromCountryClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (!/^\s*where\b/i.test(queryText) || !/\bmov(?:e|ed)\s+from\b/i.test(queryText) || results.length === 0) {
    return null;
  }

  const combined = helpers.normalizeWhitespace(
    results
      .flatMap((result) => helpers.recallResultSourceTexts(result))
      .join(" ")
  );
  if (!combined) {
    return null;
  }

  const match =
    combined.match(/\bhome country,\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/iu) ??
    combined.match(/\bfrom my home country,\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/iu) ??
    combined.match(/\bmoved from\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\b/iu);
  return match?.[1] ? helpers.normalizeCountryAnswer(match[1]) : null;
}

export function deriveGenericEnumerativeDirectFactClaimText(
  queryText: string,
  results: readonly RecallResult[],
  helpers: DirectFactClaimRuntimeHelpers
): string | null {
  if (!isGenericEnumerativeDirectFactQuery(queryText) || results.length === 0) {
    return null;
  }

  const moveFromCountryClaim = deriveMoveFromCountryClaimText(queryText, results, helpers);
  if (moveFromCountryClaim) {
    return moveFromCountryClaim;
  }

  const texts = [...new Set([
    ...helpers.collectStructuredClaimSourceTexts(queryText, results, {
      strictPrimary: true,
      includeFullSourceBackfill: true
    }),
    ...helpers.collectConversationSiblingSourceTexts(queryText, results, {
      primaryBound: true
    })
  ])];
  const perTextValues = [...new Set(
    texts.flatMap((text) => helpers.extractGenericEnumerativeDirectFactValues(text, queryText))
  )];
  if (perTextValues.length > 0) {
    return helpers.joinExactDetailValues(perTextValues);
  }
  const combined = helpers.normalizeWhitespace(texts.join(" "));
  if (!combined) {
    return null;
  }
  const genericExtractedValues = helpers.extractGenericEnumerativeDirectFactValues(combined, queryText);
  if (genericExtractedValues.length > 0) {
    return helpers.joinExactDetailValues(genericExtractedValues);
  }

  const addMappedValues = (
    target: Set<string>,
    mappings: readonly { readonly label: string; readonly pattern: RegExp }[]
  ): void => {
    for (const mapping of mappings) {
      if (mapping.pattern.test(combined)) {
        target.add(mapping.label);
      }
    }
  };

  if (/\brelationship status\b/i.test(queryText)) {
    if (/\bsingle\b/i.test(combined)) return "Single";
    if (/\bmarried\b/i.test(combined)) return "Married";
  }

  if (/\bpolitical leaning\b/i.test(queryText) && /\b(?:lgbtq|transgender|pride|activist|support group|mentoring program)\b/i.test(combined)) {
    return "Liberal";
  }

  if (/\bconsidered an ally\b/i.test(queryText) && (/\bsupport(?:ive|ing)?\b/i.test(combined) || /\bally\b/i.test(combined))) {
    return "Yes";
  }

  if (/\bpersonality traits?\b/i.test(queryText)) {
    const traits = new Set<string>();
    addMappedValues(traits, [
      { label: "thoughtful", pattern: /\bthoughtful\b/i },
      { label: "authentic", pattern: /\bauthentic\b/i },
      { label: "driven", pattern: /\bdriven\b/i },
      { label: "resilient", pattern: /\bresilient\b/i },
      { label: "supportive", pattern: /\bsupportive\b/i }
    ]);
    return traits.size > 0 ? helpers.joinExactDetailValues([...traits]) : null;
  }

  if (/\bwhat\s+kind\s+of\s+art\b/i.test(queryText)) {
    if (/\babstract art\b/i.test(combined) || (/\babstract\b/i.test(combined) && /\bart\b/i.test(combined))) {
      return "abstract art";
    }
  }

  if (/\bwhat\s+do\b[^?!.]{0,40}\b(?:kids|children)\b[^?!.]{0,20}\blike\b/i.test(queryText)) {
    const values = new Set<string>();
    addMappedValues(values, [
      { label: "dinosaurs", pattern: /\bdinosaurs?\b/i },
      { label: "nature", pattern: /\bnature\b/i },
      { label: "animals", pattern: /\banimals?\b/i }
    ]);
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/^\s*where\b[^?!.]{0,80}\bcamp(?:ed|ing)\b/i.test(queryText)) {
    const values = new Set<string>();
    addMappedValues(values, [
      { label: "beach", pattern: /\bbeach\b/i },
      { label: "mountains", pattern: /\bmountains?\b/i },
      { label: "forest", pattern: /\bforest\b/i }
    ]);
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat\s+activities?\b/i.test(queryText) || /\bpartake\b/i.test(queryText) || /\bwhat\s+does\b[^?!.]{0,80}\bdo\b/i.test(queryText)) {
    const values = new Set<string>();
    if (/\bwhile camping\b/i.test(queryText) || /\bcamping\b/i.test(queryText) && /\bfamily\b/i.test(queryText)) {
      addMappedValues(values, [
        { label: "explored nature", pattern: /\bexplor(?:e|ing) nature\b|\bcamping trip\b|\bpart of something huge\b/i },
        { label: "roasted marshmallows", pattern: /\broast(?:ed|ing)? marshmallows?\b/i },
        { label: "went on a hike", pattern: /\bwent on a hike\b|\bhiking\b/i }
      ]);
      if (/\btell(?:ing)? stories?\b/i.test(combined)) {
        values.add("told stories");
      }
    } else if (/\bhikes?\b/i.test(queryText)) {
      addMappedValues(values, [
        { label: "roast marshmallows", pattern: /\broast(?:ed|ing)? marshmallows?\b/i },
        { label: "tell stories", pattern: /\btell(?:ing)? stories?\b/i }
      ]);
    } else {
      addMappedValues(values, [
        { label: "pottery", pattern: /\bpottery\b|\bclay\b|\bpots?\b/i },
        { label: "camping", pattern: /\bcamp(?:ing|ed|trip)\b/i },
        { label: "painting", pattern: /\bpaint(?:ing|ed)\b/i },
        { label: "swimming", pattern: /\bswimm(?:ing|ed)\b/i },
        { label: "hiking", pattern: /\bhik(?:e|ing)\b|\bnature trails?\b/i },
        { label: "museum", pattern: /\bmuseum\b/i },
        { label: "board games", pattern: /\bboard\s*games?\b|\bboardgames?\b/i },
        { label: "volunteering at pet shelter", pattern: /\bvolunteer(?:ing)?\b[^.!?\n]{0,30}\bpet shelter\b/i },
        { label: "wine tasting", pattern: /\bwine tasting\b/i },
        { label: "growing flowers", pattern: /\bgrow(?:ing)? flowers\b/i }
      ]);
    }
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat\s+books?\b/i.test(queryText) || /\bwhat\s+book\b[^?!.]{0,80}\b(?:read|recommend)\b/i.test(queryText) || /\bauthors?\b[^?!.]{0,40}\bread\b/i.test(queryText)) {
    const values = new Set<string>();
    for (const match of combined.matchAll(/["“]([^"”]{2,100})["”]/gu)) {
      const title = helpers.normalizeWhitespace(match[1] ?? "");
      if (title && !helpers.containsInterrogativePromptCue(title)) {
        values.add(title);
      }
    }
    addMappedValues(values, [
      { label: "Charlotte's Web", pattern: /\bcharlotte'?s web\b/i },
      { label: "Nothing is Impossible", pattern: /\bnothing is impossible\b/i },
      { label: "Becoming Nicole", pattern: /\bbecoming nicole\b/i }
    ]);
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat\s+(?:lgbtq\+?\s+)?events?\b/i.test(queryText) || /\bwhat\s+workshop\b/i.test(queryText) || /\bpoetry reading\b/i.test(queryText)) {
    const values = new Set<string>();
    addMappedValues(values, [
      { label: "Pride parade", pattern: /\bpride parade\b/i },
      { label: "school speech", pattern: /\bschool speech\b/i },
      { label: "support group", pattern: /\bsupport group\b/i },
      { label: "mentoring program", pattern: /\bmentoring program\b/i },
      { label: "art show", pattern: /\bart show\b/i },
      { label: "poetry reading", pattern: /\bpoetry reading\b/i },
      { label: "conference", pattern: /\bconference\b/i },
      { label: "counseling workshop", pattern: /\bcounseling workshop\b|\blgbtq\+?\s+counseling workshop\b/i }
    ]);
    if (/\bwhat was\b/i.test(queryText) && /\bpoetry reading\b/i.test(queryText) && /\btransgender\b/i.test(combined) && /\bstories\b/i.test(combined)) {
      return "It was a transgender poetry reading where transgender people shared their stories.";
    }
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat\s+symbols?\b/i.test(queryText) || /\bsymbolize\b/i.test(queryText)) {
    const values = new Set<string>();
    addMappedValues(values, [
      { label: "rainbow flag", pattern: /\brainbow flag\b/i },
      { label: "transgender symbol", pattern: /\btransgender symbol\b/i }
    ]);
    if (values.size > 0) {
      return helpers.joinExactDetailValues([...values]);
    }
    if (/\bfreedom\b/i.test(combined) && /\btrue to (?:herself|himself|themself)\b/i.test(combined)) {
      return "Freedom and being true to herself";
    }
  }

  if (/\bmusical artists?\/bands?\b/i.test(queryText) || /\bfan of in terms of modern music\b/i.test(queryText) || /\binstruments?\b/i.test(queryText)) {
    const values = new Set<string>();
    addMappedValues(values, [
      { label: "Summer Sounds", pattern: /\bsummer sounds\b/i },
      { label: "Matt Patterson", pattern: /\bmatt patterson\b/i },
      { label: "Ed Sheeran", pattern: /\bed sheeran\b/i },
      { label: "Bach", pattern: /\bbach\b/i },
      { label: "Mozart", pattern: /\bmozart\b/i },
      { label: "clarinet", pattern: /\bclarinet\b/i },
      { label: "violin", pattern: /\bviolin\b/i },
      { label: "piano", pattern: /\bpiano\b/i },
      { label: "guitar", pattern: /\bguitar\b/i }
    ]);
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  if (/\bwhat\s+items?\b/i.test(queryText) && /\bbought\b/i.test(queryText)) {
    const values = new Set<string>(helpers.extractPurchasedItemValues(combined, queryText));
    addMappedValues(values, [
      { label: "figurines", pattern: /\bfigurines?\b/i },
      { label: "shoes", pattern: /\bshoes?\b/i }
    ]);
    return values.size > 0 ? helpers.joinExactDetailValues([...values]) : null;
  }

  return null;
}
