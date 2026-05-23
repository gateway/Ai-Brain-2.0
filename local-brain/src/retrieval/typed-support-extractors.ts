import {
  isBroadPreferenceProfileQuery,
  isCommunityParticipationQuery,
  isConcreteEventInventoryQuery,
  isFamilyActivityInventoryQuery
} from "./query-signals.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function uniqueNormalized(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values.map((entry) => normalize(entry)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  return [...unique.values()];
}

function splitExtractedValues(value: string): readonly string[] {
  return value
    .replace(/\b(?:and|or)\b/giu, ",")
    .split(/\s*,\s*/u)
    .map((entry) =>
      normalize(
        entry
          .replace(/^(?:the|a|an|my|our|his|her|their)\s+/iu, "")
          .replace(/\b(?:too|as well|a lot|really|quite a bit)\b/giu, "")
          .replace(/[.?!;:]+$/u, "")
      )
    )
    .filter(Boolean);
}

function sanitizeActivityExtractionText(value: string): string {
  return normalize(
    value
      .replace(/\[image:[^\]]+\]/giu, " ")
      .replace(/---\s*image_query:\s*[^-\n]+/giu, " ")
      .replace(/---\s*image_caption:\s*[^-\n]+/giu, " ")
      .replace(/---\s*image_url:\s*\S+/giu, " ")
      .replace(/\bimage caption:\s*[^.\n]+/giu, " ")
      .replace(/\bimage query:\s*[^.\n]+/giu, " ")
      .replace(/\bimage url:\s*\S+/giu, " ")
      .replace(/\bproxy reason:\s*[^.\n]+/giu, " ")
  );
}

function normalizeActivityValue(value: string): string | null {
  const normalized = normalize(
    value
      .replace(/^taking\s+/iu, "")
      .replace(/^doing\s+/iu, "")
      .replace(/^going\s+/iu, "")
      .replace(/^to\s+/iu, "")
      .replace(/\bclasses?\b/giu, "")
      .replace(/\bworkshops?\b/giu, "")
      .replace(/\s+/gu, " ")
  );
  if (!normalized) {
    return null;
  }
  if (
    /\b(?:therapy|therapeutic)\b/iu.test(normalized) ||
    /\b(?:express myself|get creative|creativity|creative outlet|self[- ]expression)\b/iu.test(normalized) ||
    /\b(?:helps? me|letting me|allows? me|for me)\b/iu.test(normalized)
  ) {
    return null;
  }
  if (
    /^(?:this|that|it|them|something|anything|everything)$/iu.test(normalized) ||
    /^(?:especially|together|lately|currently|right now|you are|we are|they are|it is|this is|that is)\b/iu.test(normalized) ||
    /\bones?\b/iu.test(normalized) ||
    /\byou are doing\b/iu.test(normalized) ||
    normalized.length > 32
  ) {
    return null;
  }
  if (/\bwatercolor painting\b/iu.test(normalized)) {
    return "watercolor painting";
  }
  if (/\bpainting\b/iu.test(normalized)) {
    return "painting";
  }
  if (/\bpottery\b/iu.test(normalized)) {
    return "pottery";
  }
  if (/\bboard\s*games?\b/iu.test(normalized)) {
    return "boardgames";
  }
  if (/\bwine tasting\b/iu.test(normalized)) {
    return "wine tasting";
  }
  if (/\bvolunteer(?:ed|ing)?\b/iu.test(normalized) && /\bpet shelter\b/iu.test(normalized)) {
    return "volunteering at pet shelter";
  }
  if (/\bgrow(?:ing|s)?\s+flowers\b/iu.test(normalized)) {
    return "growing flowers";
  }
  if (/\bbike(?:\s+ride| riding)?\b|\bcycling\b/iu.test(normalized)) {
    return "bike riding";
  }
  if (/\brunn?(?:ing)?\b/iu.test(normalized)) {
    return "running";
  }
  if (/\bdanc(?:e|ing)\b/iu.test(normalized)) {
    return "dancing";
  }
  if (/\bswimm?(?:ing)?\b/iu.test(normalized)) {
    return "swimming";
  }
  if (/\bcamp(?:ed|ing)?\b/iu.test(normalized)) {
    return "camping";
  }
  if (/\byoga\b/iu.test(normalized)) {
    return "yoga";
  }
  if (/\bhik(?:e|ing)\b/iu.test(normalized)) {
    return "hiking";
  }
  if (/\bsketch(?:ing)?\b/iu.test(normalized)) {
    return "sketching";
  }
  return normalized;
}

function isCompanionScopedActivityQuery(queryText: string): boolean {
  return (
    /\bwith\b[^?!.]{0,40}\b(?:girlfriend|boyfriend|wife|husband|partner|fianc[eé]|fiancée|gf|bf)\b/iu.test(queryText) ||
    /\b(?:girlfriend|boyfriend|wife|husband|partner|fianc[eé]|fiancée|gf|bf)\b/iu.test(queryText)
  ) && (
    /\bactivities?\b/iu.test(queryText) ||
    /\bpartake\b/iu.test(queryText) ||
    /\bpursued\b/iu.test(queryText) ||
    /\bdestress|stress relief|de-?stress|relax|chill\b/iu.test(queryText)
  );
}

function isIndoorActivityQuery(queryText: string): boolean {
  return /\bindoor activities?\b/iu.test(queryText);
}

function isIndoorCompatibleActivity(value: string): boolean {
  return [
    "boardgames",
    "wine tasting",
    "volunteering at pet shelter",
    "growing flowers",
    "pottery",
    "painting",
    "watercolor painting",
    "reading",
    "writing",
    "sketching",
    "yoga"
  ].includes(normalize(value).toLowerCase());
}

function isCompanionScopedIndoorActivityValue(value: string): boolean {
  return [
    "boardgames",
    "wine tasting",
    "volunteering at pet shelter",
    "growing flowers",
    "pottery",
    "painting",
    "watercolor painting",
    "yoga"
  ].includes(normalize(value).toLowerCase());
}

function isSupplementalCompanionIndoorActivity(value: string): boolean {
  return isCompanionScopedIndoorActivityValue(value);
}

function hasCompanionActivityCue(text: string): boolean {
  return /\b(?:girlfriend|boyfriend|wife|husband|partner|fianc[eé]|fiancée|gf|bf)\b/iu.test(text);
}

type CommunityActivityScope =
  | "community_participation"
  | "community_events"
  | "child_help"
  | "generic_activity";

function inferActivityScope(queryText: string): CommunityActivityScope {
  if (isFamilyActivityInventoryQuery(queryText)) {
    return "generic_activity";
  }
  if (/\bhelp\s+(?:children|kids|youth|young people)\b/iu.test(queryText)) {
    return "child_help";
  }
  if (/\bin what ways\b/iu.test(queryText) && /\blgbtq\+?\b|\bcommunity\b/iu.test(queryText)) {
    return "community_participation";
  }
  if (isCommunityParticipationQuery(queryText) || /\b(?:lgbtq\+?\s+)?events?\b/iu.test(queryText)) {
    return "community_events";
  }
  return "generic_activity";
}

interface CommunityPattern {
  readonly label: string;
  readonly pattern: RegExp;
  readonly scopes: readonly CommunityActivityScope[];
}

const COMMUNITY_PATTERNS: readonly CommunityPattern[] = [
  {
    label: "activist group",
    pattern: /\b(?:joined?|joining)\b[^.!?\n]{0,40}\bactivist group\b|\bconnected lgbtq activists\b/iu,
    scopes: ["community_participation"]
  },
  {
    label: "pride parade",
    pattern: /\bpride (?:parade|event|fest(?:ival)?)\b/iu,
    scopes: ["community_participation", "community_events"]
  },
  {
    label: "mentoring program",
    pattern: /\bment(?:or|orship) program\b|\bmentor(?:s|ing)?\b[^.!?\n]{0,24}\b(?:lgbtq youth|trans(?:gender)? teen|young folks?)\b/iu,
    scopes: ["community_participation", "child_help"]
  },
  {
    label: "volunteering at LGBTQ youth center",
    pattern: /\bvolunteer(?:ed|ing)?\b[^.!?\n]{0,32}\blgbtq\+?\s+youth center\b/iu,
    scopes: []
  },
  {
    label: "art show",
    pattern: /\blgbtq\b[^.!?\n]{0,24}\bart show\b|\bart show\b/iu,
    scopes: ["community_participation"]
  },
  {
    label: "poetry reading",
    pattern: /\bpoetry reading\b/iu,
    scopes: []
  },
  {
    label: "conference",
    pattern: /\b(?:lgbtq\+?|transgender)\b[^.!?\n]{0,24}\bconference\b|\bconference\b/iu,
    scopes: []
  },
  {
    label: "support group",
    pattern: /\b(?:lgbtq\+?\s+)?support group\b/iu,
    scopes: ["community_events"]
  },
  {
    label: "counseling workshop",
    pattern: /\b(?:lgbtq\+?\s+)?counseling workshop\b|\bworkshop\b[^.!?\n]{0,24}\btrans people\b/iu,
    scopes: []
  },
  {
    label: "school speech",
    pattern: /\bschool event\b|\bschool speech\b|\btalked about my transgender journey\b/iu,
    scopes: ["community_events", "child_help"]
  }
];

function matchesActivityScope(scope: CommunityActivityScope, patternScopes: readonly CommunityActivityScope[]): boolean {
  return patternScopes.includes(scope);
}

function extractChildPreferenceCandidate(value: string): string | null {
  const normalized = normalize(
    value
      .replace(/\b(?:the|a|an)\b/giu, " ")
      .replace(/\bexhibit\b/giu, "")
      .replace(/\s+/gu, " ")
  ).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    /\b(?:summer break|last one|this one|that one|the last one|the next one|school break|weekends?)\b/iu.test(normalized) ||
    /^(?:one|ones|it|them|that|this)$/iu.test(normalized)
  ) {
    return null;
  }
  if (/\bdinosaur\b/iu.test(normalized)) {
    return "dinosaurs";
  }
  if (/\bnature\b/iu.test(normalized) || /\boutdoors?\b/iu.test(normalized)) {
    return "nature";
  }
  if (/\banimals?\b/iu.test(normalized)) {
    return "animals";
  }
  return normalized.length <= 24 ? normalized : null;
}

export function hasActivitySeedEvidence(queryText: string, rawText: string): boolean {
  const text = sanitizeActivityExtractionText(rawText);
  if (!text) {
    return false;
  }
  const scope = inferActivityScope(queryText);
  if (scope !== "generic_activity") {
    return COMMUNITY_PATTERNS.some(
      ({ pattern, scopes }) => matchesActivityScope(scope, scopes) && pattern.test(text)
    );
  }
  return (
    /\b(?:family|kids|children)\b[^.!?\n]{0,40}\b(?:hike|camp|trail|workshop)\b/iu.test(text) ||
    /\b(?:pottery|camp(?:ed|ing)?|painting|swimm?(?:ing|ed)|runn?(?:ing)?|danc(?:e|ing)|yoga|hik(?:e|ing)|sketch(?:ing)?|wine tasting|board\s*games?|cycling|bike ride|pet shelter|flowers?)\b/iu.test(
      text
    ) ||
    /\b(?:partake(?:s|d)? in|participat(?:e|es|ed|ing) in|hobbies include|destress(?:es)? by|does to destress)\b/iu.test(
      text
    )
  );
}

export function inferActivityCompletenessTarget(queryText: string): number {
  if (isCompanionScopedActivityQuery(queryText) && isIndoorActivityQuery(queryText)) {
    return 4;
  }
  if (isFamilyActivityInventoryQuery(queryText)) {
    return /\b(?:camping|hikes?)\b/iu.test(queryText) ? 2 : 1;
  }
  if (/\bdestress|stress relief|de-?stress|relax|chill\b/iu.test(queryText)) {
    return 2;
  }
  if (/\bpartake\b/iu.test(queryText)) {
    return 4;
  }
  if (
    /\bwhat\s+activities?\b/iu.test(queryText) ||
    /\bin what ways\b/iu.test(queryText) ||
    /\bwhat\s+(?:events?|classes?)\b/iu.test(queryText)
  ) {
    return 3;
  }
  return 2;
}

export function inferSupportNetworkCompletenessTarget(queryText: string): number {
  if (/\bbesides\b/iu.test(queryText)) {
    return 2;
  }
  if (/\bwho\s+supports?\b/iu.test(queryText) || /^\s*who\b/iu.test(queryText)) {
    return 3;
  }
  return 2;
}

export function inferActivityEntries(params: {
  readonly queryText: string;
  readonly texts: readonly string[];
}): { readonly entries: readonly string[]; readonly entryType: "activity_name" | "event_name" | null } {
  const values = new Set<string>();
  const supplementalValues = new Set<string>();
  const childSupportQuery = /\bhelp children\b/iu.test(params.queryText) || (/\bchildren\b/iu.test(params.queryText) && /\bevents?\b/iu.test(params.queryText));
  const activityScope = inferActivityScope(params.queryText);
  const isCommunityQuery = activityScope !== "generic_activity" || childSupportQuery;
  const familyScoped = isFamilyActivityInventoryQuery(params.queryText);
  const companionScoped = isCompanionScopedActivityQuery(params.queryText);
  const indoorScoped = isIndoorActivityQuery(params.queryText);
  const destressScoped = /\bdestress|stress relief|de-?stress|relax|chill\b/iu.test(params.queryText);
  const completenessTarget = inferActivityCompletenessTarget(params.queryText);
  const genericActivityPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["pottery", /\bpottery\b/iu],
    ["camping", /\bcamp(?:ed|ing)?\b/iu],
    ["painting", /\b(?:watercolor )?painting\b/iu],
    ["swimming", /\bswimm?(?:ing|ed)\b/iu],
    ["running", /\brunn?(?:ing|ing)|\bran\b/iu],
    ["dancing", /\bdanc(?:e|ing)\b/iu],
    ["yoga", /\byoga\b/iu],
    ["hiking", /\bhik(?:e|ing)\b/iu],
    ["sketching", /\bsketch(?:ing)?\b/iu]
  ];

  for (const rawText of params.texts) {
    const text = sanitizeActivityExtractionText(rawText);
    if (!text) {
      continue;
    }
    const companionCue = hasCompanionActivityCue(text);
    if (isCommunityQuery) {
      for (const { label, pattern, scopes } of COMMUNITY_PATTERNS) {
        if (matchesActivityScope(activityScope, scopes) && pattern.test(text)) {
          values.add(label);
        }
      }
      continue;
    }

    const candidateValues = new Set<string>();
    for (const [label, pattern] of genericActivityPatterns) {
      if (
        label === "running" &&
        !destressScoped &&
        /\bdestress|de-?stress|clear my mind|headspace|reset|recharge|me-time|refresh(?:es|ing)? me|stay present\b/iu.test(text)
      ) {
        continue;
      }
      if (pattern.test(text)) {
        candidateValues.add(label);
      }
    }

    if (/\bwine tasting\b/iu.test(text)) {
      candidateValues.add("wine tasting");
    }
    if (/\bboard\s*games?\b/iu.test(text)) {
      candidateValues.add("boardgames");
    }
    if (/\bvolunteer(?:ed|ing)?\b/iu.test(text) && /\bpet shelter\b/iu.test(text)) {
      candidateValues.add("volunteering at pet shelter");
    }
    if (
      /\bgrow(?:ing|s)?\s+flowers\b/iu.test(text) ||
      /\btaking care of\b[^.!?\n]{0,24}\bflowers?\b/iu.test(text) ||
      (/\btaking care of lately\b/iu.test(text) && /\bflowers?\b/iu.test(text)) ||
      (/\btaking care of lately\b/iu.test(text) && /\b(?:garden|veggie patch|peruvian lilies)\b/iu.test(text))
    ) {
      candidateValues.add("growing flowers");
    }
    if (/\b(?:went on|went for|went to)\s+(?:a\s+|an\s+|the\s+)?bike ride\b/iu.test(text) || /\bcycling\b/iu.test(text)) {
      candidateValues.add("bike riding");
    }
    if (familyScoped) {
      if (/\b(?:hike|hiking)\b/iu.test(text)) {
        candidateValues.add("hiking");
      }
      if (/\b(?:camp|camping)\b/iu.test(text)) {
        candidateValues.add("camping");
      }
      if (/\bmeteor showers?\b/iu.test(text)) {
        candidateValues.add("watching a meteor shower");
      }
      if (/\bworkshop\b/iu.test(text) && /\bdiscuss(?:ed|ing|ion)\b/iu.test(text)) {
        candidateValues.add("workshop discussion");
      }
    }

    for (const match of text.matchAll(
      /\b(?:destress(?:es)? by|does\s+to\s+destress|partake(?:s|d)? in|participat(?:e|es|ed|ing)\s+in|enjoys?|likes?|loves?|hobbies include)\s+([^.!?\n]+)/giu
    )) {
      for (const entry of splitExtractedValues(match[1] ?? "")) {
        const normalizedValue = normalizeActivityValue(entry);
        if (normalizedValue) {
          candidateValues.add(normalizedValue);
        }
      }
    }

    if (!companionScoped || companionCue) {
      for (const value of candidateValues) {
        values.add(value);
      }
      continue;
    }
    for (const value of candidateValues) {
      if ((!indoorScoped || isIndoorCompatibleActivity(value)) && isSupplementalCompanionIndoorActivity(value)) {
        supplementalValues.add(value);
      }
    }
  }

  const primaryEntries = uniqueNormalized([...values].filter((value) => {
    if (companionScoped && indoorScoped) {
      return isCompanionScopedIndoorActivityValue(value);
    }
    return !indoorScoped || isIndoorCompatibleActivity(value);
  }));
  const supplementalEntries =
    companionScoped && primaryEntries.length < completenessTarget
      ? uniqueNormalized(
          [...supplementalValues]
            .filter((value) => !primaryEntries.includes(value))
            .filter((value) =>
              companionScoped && indoorScoped
                ? isCompanionScopedIndoorActivityValue(value)
                : !indoorScoped || isIndoorCompatibleActivity(value)
            )
        )
      : [];
  const entries = uniqueNormalized([...primaryEntries, ...supplementalEntries]);
  if (entries.length === 0) {
    return { entries: [], entryType: null };
  }
  return {
    entries,
    entryType: isCommunityQuery ? "event_name" : "activity_name"
  };
}

export function inferPreferenceProfileValues(params: {
  readonly queryText: string;
  readonly texts: readonly string[];
}): readonly string[] {
  if (!isBroadPreferenceProfileQuery(params.queryText)) {
    return [];
  }
  const values = new Set<string>();
  const childrenScoped = /\bkids?\b|\bchildren\b/iu.test(params.queryText);
  let hasChildScopedContext = false;
  let sawDinosaurCue = false;
  let sawNatureCue = false;

  for (const rawText of params.texts) {
    const text = normalize(rawText);
    if (!text) {
      continue;
    }
    if (childrenScoped && /\b(?:kids?|children|sons?|daughters?)\b/iu.test(text)) {
      hasChildScopedContext = true;
    }
    const patterns = childrenScoped
      ? [
          /\b(?:kids?|children|sons?|daughters?)\b[^.!?\n]{0,40}\b(?:like|love|enjoy|are into)\s+([^.!?\n]+)/giu,
          /\b(?:their|the)\s+(?:kids?|children)\b[^.!?\n]{0,20}\b(?:favorite|favorites)\b[^.!?\n]{0,10}\b(?:are|include)\s+([^.!?\n]+)/giu,
          /\b(?:kids?|children)\b[^.!?\n]{0,30}\b(?:stoked for|excited about|obsessed with|really into)\s+([^.!?\n]+)/giu
        ]
      : [
          /\b(?:like|love|enjoy|are into)\s+([^.!?\n]+)/giu
        ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        for (const entry of splitExtractedValues(match[1] ?? "")) {
          const normalizedValue = normalize(
            entry
              .replace(/\b(?:the most|most of all)\b/giu, "")
              .replace(/\b(?:really|absolutely)\b/giu, "")
              .replace(/\s+/gu, " ")
          );
          if (!normalizedValue || normalizedValue.length > 32) {
            continue;
          }
          if (/\b(?:them|that|this|it|stuff|things?)\b/iu.test(normalizedValue)) {
            continue;
          }
          if (childrenScoped) {
            const childCandidate = extractChildPreferenceCandidate(normalizedValue);
            if (childCandidate) {
              values.add(childCandidate);
            }
            continue;
          }
          values.add(normalizedValue);
        }
      }
    }
    if (childrenScoped && /\bdinosaur\b/iu.test(text)) {
      sawDinosaurCue = true;
      if (/\b(?:kids?|children)\b/iu.test(text)) {
        values.add("dinosaurs");
      }
    }
    if (childrenScoped && (/\bnature\b/iu.test(text) || /\boutdoors?\b/iu.test(text))) {
      sawNatureCue = true;
      if (/\b(?:kids?|children)\b/iu.test(text)) {
        values.add("nature");
      }
    }
  }

  if (childrenScoped && hasChildScopedContext) {
    if (sawDinosaurCue) {
      values.add("dinosaurs");
    }
    if (sawNatureCue) {
      values.add("nature");
    }
  }

  return uniqueNormalized([...values]);
}

export function inferPetInventoryValues(texts: readonly string[]): readonly string[] {
  const values = new Set<string>();
  for (const rawText of texts) {
    const text = normalize(rawText).toLowerCase();
    if (!text) {
      continue;
    }
    if (/\bdogs?\b/iu.test(text)) values.add("dog");
    if (/\bcats?\b/iu.test(text)) values.add("cat");
    if (/\bturtles?\b/iu.test(text)) values.add("turtle");
    if (/\bbirds?\b/iu.test(text)) values.add("bird");
    if (/\bfish\b/iu.test(text)) values.add("fish");
    if (/\bhamsters?\b/iu.test(text)) values.add("hamster");
    if (/\brabbits?\b/iu.test(text)) values.add("rabbit");
    if (/\blizards?\b/iu.test(text)) values.add("lizard");
    if (/\bsnakes?\b/iu.test(text)) values.add("snake");
  }
  return uniqueNormalized([...values]);
}

export function inferProfileTraitJudgmentValue(params: {
  readonly queryText: string;
  readonly texts: readonly string[];
}): string | null {
  const combined = normalize(params.texts.join(" ")).toLowerCase();
  if (!combined) {
    return null;
  }
  if (/\breligious\b/iu.test(params.queryText)) {
    if (/\bnot religious\b|\bnot very religious\b|\bnot really religious\b/iu.test(combined)) {
      return "Likely no";
    }
    if (/\bchurch\b|\bfaith\b|\bspiritual\b|\breligious\b/iu.test(combined)) {
      return "Likely yes";
    }
  }
  if (/\bpatriotic\b/iu.test(params.queryText)) {
    if (/\bnot patriotic\b|\bnot very patriotic\b|\bnot really patriotic\b/iu.test(combined)) {
      return "Likely no";
    }
    if (
      /\bpatriotic\b|\bpatriot(?:ism|ic)?\b|\bproud to be (?:an? )?(?:american|citizen)\b|\bproud of (?:my|their|our) country\b|\blove (?:my|their|our) country\b|\bfourth of july\b|\bindependence day\b|\bnational anthem\b|\bflag\b/iu.test(
        combined
      )
    ) {
      return "Likely yes";
    }
  }
  if (/\bpersonality traits?\b|\btraits?\b/iu.test(params.queryText)) {
    const traitMatches = combined.match(/\b(kind|creative|supportive|caring|thoughtful|resilient|compassionate|funny|patient|determined)\b(?:[^.!?\n]{0,30}\b(kind|creative|supportive|caring|thoughtful|resilient|compassionate|funny|patient|determined)\b){0,3}/iu);
    return traitMatches?.[0] ?? null;
  }
  if (/\b(?:enjoy|like|love)\b/iu.test(params.queryText) || /\bmove back\b|\broadtrip\b/iu.test(params.queryText)) {
    if (/\b(no|not)\b[^.!?\n]{0,20}\b(?:enjoy|like|want|would)\b/iu.test(combined)) {
      return "Likely no";
    }
    if (/\b(yes|would|likely|probably)\b/iu.test(combined)) {
      return "Likely yes";
    }
  }
  if (/\bpolitical leaning\b/iu.test(params.queryText)) {
    return combined.match(/\b(progressive|liberal|conservative|moderate|left-leaning|right-leaning)\b/iu)?.[0] ?? null;
  }
  return null;
}
