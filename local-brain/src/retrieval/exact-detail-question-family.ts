export type ExactDetailQuestionFamily =
  | "pet_name"
  | "breed"
  | "brand"
  | "count"
  | "service_name"
  | "playlist_name"
  | "last_name"
  | "venue"
  | "certification"
  | "capacity"
  | "speed"
  | "time_of_day"
  | "duration"
  | "hobbies"
  | "allergy_safe_pets"
  | "favorite_movie"
  | "favorite_memory"
  | "pastry_items"
  | "social_exclusion"
  | "underlying_condition"
  | "endorsement_company"
  | "habit_start_activity"
  | "preseason_challenge"
  | "flower_type"
  | "state"
  | "inspiration_source"
  | "research_topic"
  | "realization"
  | "summer_adoption_plan"
  | "temporary_job"
  | "favorite_painting_style"
  | "martial_arts"
  | "main_focus"
  | "meal_companion"
  | "favorite_books"
  | "plural_names"
  | "goals"
  | "owned_pets"
  | "purchased_items"
  | "food_drink"
  | "age_at_event"
  | "bands"
  | "broken_items"
  | "team"
  | "role"
  | "shop"
  | "country"
  | "symbolic_gifts"
  | "deceased_people"
  | "favorite_band"
  | "favorite_dj"
  | "color"
  | "car"
  | "advice"
  | "bird_type"
  | "meat_preference"
  | "project_type"
  | "creative_work"
  | "price"
  | "stance"
  | "generic";

export type ExactDetailReaderPriority = "current_state_first" | "event_first";

export interface ExactDetailFamilySpec {
  readonly family: ExactDetailQuestionFamily;
  readonly aggressiveCutover: boolean;
  readonly queryFamily: "current_state" | "exact_detail";
  readonly readerPriority: ExactDetailReaderPriority;
  readonly scalarPropertyKeys: readonly string[];
  readonly scalarMatchTerms: readonly string[];
  readonly eventPredicateFamilies: readonly string[];
  readonly eventMatchTerms: readonly string[];
  readonly selfOwned: boolean;
}

const ATOMIC_EXACT_DETAIL_QUESTION_FAMILIES = new Set<ExactDetailQuestionFamily>([
  "age_at_event",
  "brand",
  "breed",
  "capacity",
  "certification",
  "color",
  "count",
  "creative_work",
  "duration",
  "food_drink",
  "last_name",
  "pet_name",
  "playlist_name",
  "price",
  "role",
  "service_name",
  "shop",
  "speed",
  "stance",
  "time_of_day",
  "venue"
]);

export function isAtomicExactDetailQuestionFamily(family: ExactDetailQuestionFamily): boolean {
  return ATOMIC_EXACT_DETAIL_QUESTION_FAMILIES.has(family);
}

const EXACT_DETAIL_FAMILY_SPECS: Partial<Record<ExactDetailQuestionFamily, ExactDetailFamilySpec>> = {
  pet_name: {
    family: "pet_name",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["pet_name", "cat_name", "dog_name", "animal_name"],
    scalarMatchTerms: ["pet", "cat", "dog", "name"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  breed: {
    family: "breed",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["breed", "pet_breed", "dog_breed", "cat_breed"],
    scalarMatchTerms: ["breed", "pet", "dog", "cat"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  brand: {
    family: "brand",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["brand", "shoe_brand", "running_shoe_brand", "favorite_brand"],
    scalarMatchTerms: ["brand", "shoe", "running", "sneaker"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  count: {
    family: "count",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["count", "bike_count", "item_count", "owned_count", "packed_item_count", "activity_count"],
    scalarMatchTerms: ["count", "number", "total", "bike", "bikes", "own", "packed", "shirts", "caught", "fish", "bass"],
    eventPredicateFamilies: ["list_set", "temporal_event_fact", "activity_count", "trip_count"],
    eventMatchTerms: ["count", "number", "total", "owned", "packed", "caught", "fishing", "bass", "trip"],
    selfOwned: true
  },
  service_name: {
    family: "service_name",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["service_name", "provider", "platform", "subscription_service", "music_service"],
    scalarMatchTerms: ["service", "platform", "provider", "app", "subscription", "music", "streaming"],
    eventPredicateFamilies: ["temporal_event_fact"],
    eventMatchTerms: ["service", "provider", "platform", "subscription"],
    selfOwned: true
  },
  playlist_name: {
    family: "playlist_name",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["playlist_name", "spotify_playlist_name", "music_playlist_name"],
    scalarMatchTerms: ["playlist", "spotify", "music", "created", "called", "named"],
    eventPredicateFamilies: ["temporal_event_fact"],
    eventMatchTerms: ["playlist", "spotify", "music", "created", "called", "named"],
    selfOwned: true
  },
  last_name: {
    family: "last_name",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["previous_last_name", "last_name", "maiden_name", "former_name"],
    scalarMatchTerms: ["last name", "surname", "maiden", "former", "changed"],
    eventPredicateFamilies: ["identity_history", "temporal_event_fact"],
    eventMatchTerms: ["last name", "surname", "maiden", "former", "changed"],
    selfOwned: true
  },
  venue: {
    family: "venue",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["venue", "school", "campus", "class_location", "program_location", "study_location"],
    scalarMatchTerms: ["venue", "school", "campus", "college", "university", "class", "study abroad", "program"],
    eventPredicateFamilies: ["work_education_history", "temporal_event_fact", "location_history"],
    eventMatchTerms: ["venue", "school", "campus", "college", "university", "study abroad", "program", "class"],
    selfOwned: true
  },
  certification: {
    family: "certification",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["certification", "credential", "certificate", "course_completion", "degree", "field_of_study"],
    scalarMatchTerms: ["certification", "certificate", "credential", "course", "program", "degree", "graduate", "major"],
    eventPredicateFamilies: ["work_education_history", "temporal_event_fact"],
    eventMatchTerms: ["certification", "certificate", "credential", "course", "program", "degree", "graduate", "major"],
    selfOwned: true
  },
  capacity: {
    family: "capacity",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["capacity", "ram", "storage", "device_capacity", "plan_capacity"],
    scalarMatchTerms: ["capacity", "ram", "storage", "gb", "tb"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  speed: {
    family: "speed",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["speed", "internet_speed", "plan_speed", "network_speed"],
    scalarMatchTerms: ["speed", "internet", "network", "plan", "mbps", "gbps"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  time_of_day: {
    family: "time_of_day",
    aggressiveCutover: true,
    queryFamily: "current_state",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["time_of_day", "stop_time", "routine_time", "checking_email_stop_time"],
    scalarMatchTerms: ["time", "time of day", "stop", "checking", "emails", "messages"],
    eventPredicateFamilies: [],
    eventMatchTerms: [],
    selfOwned: true
  },
  duration: {
    family: "duration",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["duration", "duration_held", "time_spent", "stay_duration"],
    scalarMatchTerms: ["duration", "how long", "months", "years", "weeks", "days"],
    eventPredicateFamilies: ["temporal_event_fact", "location_history", "work_history", "work_education_history"],
    eventMatchTerms: ["duration", "months", "years", "weeks", "days", "stayed", "lived", "worked"],
    selfOwned: true
  },
  role: {
    family: "role",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["role", "job", "occupation", "title", "position"],
    scalarMatchTerms: ["role", "job", "occupation", "title", "position"],
    eventPredicateFamilies: ["work_history", "work_education_history", "temporal_event_fact"],
    eventMatchTerms: ["role", "job", "occupation", "title", "position", "worked as"],
    selfOwned: true
  },
  shop: {
    family: "shop",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["shop", "store", "retailer", "purchase_source"],
    scalarMatchTerms: ["shop", "store", "retailer", "bought from", "purchased from"],
    eventPredicateFamilies: ["temporal_event_fact", "ownership_binding"],
    eventMatchTerms: ["shop", "store", "retailer", "buy", "bought", "purchase", "purchased"],
    selfOwned: true
  },
  creative_work: {
    family: "creative_work",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["creative_work", "performance_title", "recipe_title", "media_title", "play_title", "cocktail_recipe"],
    scalarMatchTerms: ["play", "production", "performance", "recipe", "cocktail", "book", "movie", "title", "called", "named"],
    eventPredicateFamilies: ["temporal_event_fact", "creative_work", "media_event"],
    eventMatchTerms: ["attended", "watched", "read", "tried", "made", "production", "recipe", "cocktail", "play", "title"],
    selfOwned: true
  },
  price: {
    family: "price",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["price", "cost", "purchase_price", "amount_spent", "money_amount", "expense_amount"],
    scalarMatchTerms: ["how much", "worth", "spend", "spent", "paid", "cost", "price", "dollars", "$", "purchase"],
    eventPredicateFamilies: ["purchase_event", "transaction", "temporal_event_fact"],
    eventMatchTerms: ["worth", "spent", "paid", "cost", "bought", "purchased", "price", "dollars", "handbag"],
    selfOwned: true
  },
  stance: {
    family: "stance",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["stance", "belief", "view", "opinion", "position", "previous_stance", "former_stance"],
    scalarMatchTerms: ["stance", "belief", "view", "opinion", "position", "previous", "former", "used to", "spirituality"],
    eventPredicateFamilies: ["belief_history", "identity_history", "temporal_event_fact"],
    eventMatchTerms: ["stance", "belief", "view", "opinion", "position", "previous", "former", "used to", "atheist"],
    selfOwned: true
  },
  purchased_items: {
    family: "purchased_items",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["purchased_item", "gift_item", "bought_item", "purchase_item", "item_type", "object_value"],
    scalarMatchTerms: ["buy", "bought", "purchase", "gift", "coupon", "thrift", "store", "item"],
    eventPredicateFamilies: ["temporal_event_fact", "ownership_binding", "purchase_event"],
    eventMatchTerms: ["buy", "bought", "purchase", "gift", "redeem", "coupon", "thrift", "store", "item"],
    selfOwned: true
  },
  food_drink: {
    family: "food_drink",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["food_drink", "food_item", "drink_item", "recipe_type", "cake_type", "rice_type", "cocktail_type", "favorite_food"],
    scalarMatchTerms: ["food", "drink", "recipe", "cake", "rice", "cocktail", "bake", "favorite"],
    eventPredicateFamilies: ["temporal_event_fact", "food_event", "preference"],
    eventMatchTerms: ["food", "drink", "recipe", "cake", "rice", "cocktail", "bake", "favorite"],
    selfOwned: true
  },
  age_at_event: {
    family: "age_at_event",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "event_first",
    scalarPropertyKeys: ["age_at_event", "age", "event_age"],
    scalarMatchTerms: ["age", "old", "birthday", "when"],
    eventPredicateFamilies: ["temporal_event_fact", "life_event"],
    eventMatchTerms: ["age", "old", "birthday", "gave", "gift"],
    selfOwned: true
  },
  color: {
    family: "color",
    aggressiveCutover: true,
    queryFamily: "exact_detail",
    readerPriority: "current_state_first",
    scalarPropertyKeys: ["color", "paint_color", "wall_color", "hair_color", "item_color"],
    scalarMatchTerms: ["color", "colour", "shade", "paint", "repaint", "painted", "hair", "dyed", "dye", "gray", "grey"],
    eventPredicateFamilies: ["temporal_event_fact"],
    eventMatchTerms: ["color", "colour", "shade", "paint", "repaint", "painted", "wall", "hair", "dyed", "dye"],
    selfOwned: true
  }
};

export function getExactDetailFamilySpec(
  family: ExactDetailQuestionFamily
): ExactDetailFamilySpec | null {
  return EXACT_DETAIL_FAMILY_SPECS[family] ?? null;
}

export function isAggressiveExactDetailCutoverFamily(
  family: ExactDetailQuestionFamily
): boolean {
  return getExactDetailFamilySpec(family)?.aggressiveCutover === true;
}

export function isFirstPersonExactDetailQuery(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
}

export function inferExactDetailQuestionFamily(queryText: string): ExactDetailQuestionFamily {
  const lowered = queryText.toLowerCase();
  if (/\b(?:pet|pets|dog|dogs|cat|cats|turtle|turtles)\b/.test(lowered) && /\bname\b/.test(lowered)) {
    return "pet_name";
  }
  if (/\bwhat\s+breed\b/.test(lowered) || (/\bbreed\b/.test(lowered) && /\b(?:dog|cat|pet)\b/.test(lowered))) {
    return "breed";
  }
  if (/\bwhat\s+brand\b/.test(lowered)) {
    return "brand";
  }
  if (/\bhow\s+many\b/.test(lowered)) {
    return "count";
  }
  if (/\bhow\s+old\b/.test(lowered)) {
    return "age_at_event";
  }
  if (
    ((/\bhow\s+much\b/.test(lowered) && /\b(?:spend|spent|pay|paid|cost|price|purchase|bought|handbag|bag|item|worth)\b/.test(lowered)) ||
      (/\bwhat(?:'s|\s+is)?\b/.test(lowered) && /\bworth\b/.test(lowered)))
  ) {
    return "price";
  }
  if (
    /\b(?:previous|former|old|current)?\s*(?:stance|view|belief|opinion|position)\b/.test(lowered) ||
    (/\b(?:used to|previously|formerly)\b/.test(lowered) && /\b(?:believe|think|atheist|spirituality|religion)\b/.test(lowered))
  ) {
    return "stance";
  }
  if (
    (/\bname of the\b/.test(lowered) || /\bwhat\s+(?:is|was)\s+the\s+name\b/.test(lowered)) &&
    /\b(?:service|platform|app|provider|music|streaming)\b/.test(lowered)
  ) {
    return "service_name";
  }
  if (/\b(?:name of the|what)\b/.test(lowered) && /\bplaylist\b/.test(lowered)) {
    return "playlist_name";
  }
  if (/\blast name\b/.test(lowered) && /\b(?:before|changed|former|previous)\b/.test(lowered)) {
    return "last_name";
  }
  if (
    /\bwhere\s+do\b.+\b(?:take|go to)\b.+\bclasses?\b/.test(lowered) ||
    /\bwhere\s+did\b.+\battend\b.+\b(?:study abroad|program|university|college|school|wedding)\b/.test(lowered) ||
    /\bwhere\s+did\b.+\bcomplete\b.+\b(?:degree|bachelor|certification|program)\b/.test(lowered)
  ) {
    return "venue";
  }
  if (/\bwhat\s+certification\b/.test(lowered)) {
    return "certification";
  }
  if (/\bwhat\s+degree\b/.test(lowered) || (/\bdegree\b/.test(lowered) && /\bgraduat/.test(lowered))) {
    return "certification";
  }
  if (/\bhow\s+much\s+ram\b/.test(lowered)) {
    return "capacity";
  }
  if (/\bscreen\s+time\b/.test(lowered) && /\b(?:how much|average|averaging|per day|daily)\b/.test(lowered)) {
    return "duration";
  }
  if (/\bcommute\b/.test(lowered) && /\b(?:how long|daily|work|minutes?|hours?)\b/.test(lowered)) {
    return "duration";
  }
  if (
    /\bhow\s+long\b/.test(lowered) &&
    (
      /\b(?:take|took)\b.*\b(?:assemble|assembly|build|built|put together|bookshelf|furniture)\b/.test(lowered) ||
      /\b(?:assemble|assembly|build|built|put together|bookshelf|furniture)\b.*\b(?:take|took)\b/.test(lowered) ||
      /\b(?:move|moved|moving)\b.*\b(?:apartment|house|place|home)\b/.test(lowered) ||
      /\b(?:apartment|house|place|home)\b.*\b(?:move|moved|moving)\b/.test(lowered) ||
      /\b(?:in|around|through|visited|visit|stayed|stay|travel(?:ed|led)?|trip)\b.*\b(?:japan|country|city|place)\b/.test(lowered) ||
      /\b(?:japan|country|city|place)\b.*\b(?:for|trip|visit|visited|stayed|travel(?:ed|led)?)\b/.test(lowered)
    )
  ) {
    return "duration";
  }
  if (/\bwhat\s+speed\b/.test(lowered) && /\bplan\b/.test(lowered)) {
    return "speed";
  }
  if (/\bwhat\s+time\b/.test(lowered)) {
    return "time_of_day";
  }
  if (/\bunderlying condition\b/.test(lowered) || (/\ballerg/.test(lowered) && /\bcondition\b/.test(lowered))) {
    return "underlying_condition";
  }
  if (/\bhow\s+long\b/.test(lowered) && /\b(?:have|has|had)\b/.test(lowered)) {
    return "duration";
  }
  if ((/\bcompany\b/.test(lowered) || /\bbrand\b/.test(lowered)) && /\bendorsement\b/.test(lowered)) {
    return "endorsement_company";
  }
  if (
    /\bwhat\s+did\b/.test(lowered) &&
    /\bstart(?:ed|ing)?\s+doing\b/.test(lowered) &&
    /\b(?:stress|stress-buster|stress relief|happy place|escape)\b/.test(lowered)
  ) {
    return "habit_start_activity";
  }
  if (/\bchallenge\b/.test(lowered) && /\bpre-?season training\b/.test(lowered)) {
    return "preseason_challenge";
  }
  if (/\bflowers?\b/.test(lowered) && /\btattoo\b/.test(lowered)) {
    return "flower_type";
  }
  if (/\bin which state\b/.test(lowered) || (/\bwhat state\b/.test(lowered) && /\bshelter\b/.test(lowered))) {
    return "state";
  }
  if (/\bwhat inspired\b/.test(lowered) && /\bcreate\b/.test(lowered)) {
    return "inspiration_source";
  }
  if (/\bfavorite\s+movie\s+trilog(?:y|ies)\b/.test(lowered)) {
    return "favorite_movie";
  }
  if (/\bfavorite\b[^?!.]{0,40}\bmemory\b/.test(lowered)) {
    return "favorite_memory";
  }
  if (/\bwhat\s+kind\s+of\s+pastr(?:y|ies)\b/.test(lowered) || (/\bpastr(?:y|ies)\b/.test(lowered) && /\bcafe\b/.test(lowered))) {
    return "pastry_items";
  }
  if (
    /\bwhat\s+(?:type|kind)\s+of\b/.test(lowered) &&
    /\b(?:cocktail|recipe|rice|cake|food|drink|action figure)\b/.test(lowered)
  ) {
    return /\baction figure\b/.test(lowered) ? "purchased_items" : "food_drink";
  }
  if (/\bwhat\s+did\b/.test(lowered) && /\bbake\b/.test(lowered)) {
    return "food_drink";
  }
  if (/\bhobbies?\b/.test(lowered)) {
    return "hobbies";
  }
  if (/\bpets?\s+wouldn'?t\s+cause\b/.test(lowered) || (/\bpets?\b/.test(lowered) && /\ballerg/.test(lowered))) {
    return "allergy_safe_pets";
  }
  if (/\bbesides\b/.test(lowered) && /\bfriends?\b/.test(lowered)) {
    return "social_exclusion";
  }
  if (/\bwhat\s+did\b/.test(lowered) && /\bresearch\b/.test(lowered)) {
    return "research_topic";
  }
  if (/\bwhat\s+did\b/.test(lowered) && /\brealiz/.test(lowered)) {
    return "realization";
  }
  if (/\bplans?\b/.test(lowered) && /\bsummer\b/.test(lowered) && /\badoption\b/.test(lowered)) {
    return "summer_adoption_plan";
  }
  if (/\btemporary\s+job\b/.test(lowered)) {
    return "temporary_job";
  }
  if (/\bfavorite\s+style\s+of\s+painting\b/.test(lowered)) {
    return "favorite_painting_style";
  }
  if (/\bwhat\s+martial\s+arts?\b/.test(lowered) || /\bmartial\s+arts?\s+has\b/.test(lowered)) {
    return "martial_arts";
  }
  if (/\bmain\s+focus\b/.test(lowered)) {
    return "main_focus";
  }
  if (/\bwho\b/.test(lowered) && /\b(?:dinner|lunch|breakfast)\b/.test(lowered)) {
    return "meal_companion";
  }
  if (/\bfavorite\s+books?\b/.test(lowered)) {
    return "favorite_books";
  }
  if ((/\bwhat\s+books?\b/.test(lowered) && /\b(?:has|have|did|read|recommended?)\b/.test(lowered)) || /\bauthors?\b[^?!.]{0,40}\bread\b/.test(lowered)) {
    return "generic";
  }
  if (/\bwhat\s+are\s+the\s+names?\b/.test(lowered) || /\bnames?\b/.test(lowered)) {
    return "plural_names";
  }
  if (/\bgoals?\b/.test(lowered) && /\b(?:career|basketball|endorsements?|brand|charity)\b/.test(lowered)) {
    return "goals";
  }
  if (/\bwhat\s+pets?\s+does\b/.test(lowered) || /\bwhat\s+pet\s+does\b/.test(lowered)) {
    return "owned_pets";
  }
  if (
    /\bwhat\s+items?\s+(?:did|has|have)\b/.test(lowered) ||
    (/\bwhat\s+did\b/.test(lowered) && /\b(?:buy|purchase|redeem)\b/.test(lowered))
  ) {
    return "purchased_items";
  }
  if (/\bfavorite\b/.test(lowered) && /\bband\b/.test(lowered)) {
    return "favorite_band";
  }
  if (/\bfavorite\b/.test(lowered) && /\bdj\b/.test(lowered)) {
    return "favorite_dj";
  }
  if (/\bwhich\s+bands?\b/.test(lowered) || /\bwhat\s+bands?\b/.test(lowered) || /\bmusical artists?\/bands?\b/.test(lowered)) {
    return "bands";
  }
  if (/\bwhat\s+kinds?\s+of\s+things?\b/.test(lowered) && /\bbroken\b/.test(lowered)) {
    return "broken_items";
  }
  if (
    /\b(?:what|which)\s+(?:team|club|organization|company|employer)\b/.test(lowered) ||
    (/\bsign(?:ed)?\s+with\b/.test(lowered) && /\bteam\b/.test(lowered))
  ) {
    return "team";
  }
  if (
    /\b(?:what|which)\s+(?:position|role|title|job)\b/.test(lowered) ||
    /\bwhat\s+is\b[^?!.]{0,80}\b(?:position|role|title|job)\b/.test(lowered) ||
    /\bprevious\s+occupation\b/.test(lowered)
  ) {
    return "role";
  }
  if (/\b(?:what|which)\s+(?:shop|store)\b/.test(lowered) || /\benjoy\s+visiting\b/.test(lowered)) {
    return "shop";
  }
  if (
    /\bwhere\s+did\b/.test(lowered) &&
    /\b(?:buy|bought|purchase|purchased|redeem|redeemed|coupon)\b/.test(lowered)
  ) {
    return "shop";
  }
  if (/\bwhich\s+country\b/.test(lowered) || /\bwhat\s+country\b/.test(lowered)) {
    return "country";
  }
  if (/\bsymbolic\s+gifts?\b/.test(lowered) || /\bpendant\b/.test(lowered)) {
    return "symbolic_gifts";
  }
  if (/\bpassed away\b/.test(lowered) || /\bdied\b/.test(lowered)) {
    return "deceased_people";
  }
  if (/\bspecific\s+type\s+of\s+bird\b/.test(lowered) || /\bwhat\s+kind\s+of\s+bird\b/.test(lowered)) {
    return "bird_type";
  }
  if (/\bwhich\s+meat\b/.test(lowered) || (/\bprefer(?:s|red)?\b/.test(lowered) && /\bmeat\b/.test(lowered))) {
    return "meat_preference";
  }
  if (/\bwhat\s+kind\s+of\s+project\b/.test(lowered) || (/\bproject\b/.test(lowered) && /\bbeginning\s+of\s+january\s+2023\b/.test(lowered))) {
    return "project_type";
  }
  if (
    /\b(?:what|which)\s+(?:play|production|performance|book|movie|film|song|title)\b/.test(lowered) ||
    (/\bwhat\s+(?:type|kind)\s+of\b/.test(lowered) && /\b(?:cocktail|recipe)\b/.test(lowered))
  ) {
    return "creative_work";
  }
  if (/\bwhat\s+color\b/.test(lowered)) {
    return "color";
  }
  if (/\bwhat\s+type\s+of\s+car\b/.test(lowered) || /\bwhat\s+kind\s+of\s+car\b/.test(lowered)) {
    return "car";
  }
  if (/\bwhat\s+advice\s+did\b/.test(lowered)) {
    return "advice";
  }
  return "generic";
}
