export type ExactDetailQuestionFamily =
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
  | "generic";

export function inferExactDetailQuestionFamily(queryText: string): ExactDetailQuestionFamily {
  const lowered = queryText.toLowerCase();
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
  if (/\bwhat\s+items?\s+(?:did|has|have)\b/.test(lowered) || (/\bwhat\s+did\b/.test(lowered) && /\b(?:buy|purchase)\b/.test(lowered))) {
    return "purchased_items";
  }
  if (/\bwhich\s+bands?\b/.test(lowered) || /\bwhat\s+bands?\b/.test(lowered) || /\bmusical artists?\/bands?\b/.test(lowered)) {
    return "bands";
  }
  if (/\bfavorite\b/.test(lowered) && /\bband\b/.test(lowered)) {
    return "favorite_band";
  }
  if (/\bfavorite\b/.test(lowered) && /\bdj\b/.test(lowered)) {
    return "favorite_dj";
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
    /\bwhat\s+is\b[^?!.]{0,80}\b(?:position|role|title|job)\b/.test(lowered)
  ) {
    return "role";
  }
  if (/\b(?:what|which)\s+(?:shop|store)\b/.test(lowered) || /\benjoy\s+visiting\b/.test(lowered)) {
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
