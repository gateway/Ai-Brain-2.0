import {
  isConcreteBookHistoryQuery,
  isConcreteEventInventoryQuery,
  isConcreteInstrumentInventoryQuery,
  isConcreteLocationHistoryQuery,
  isConcreteMusicArtistHistoryQuery,
  isConcretePaintedItemQuery,
  isConcretePetNameQuery,
  isConcretePotteryItemQuery,
  isConcreteSupportNetworkQuery,
  isConcreteSymbolInventoryQuery,
  isFamilyActivityInventoryQuery,
  isIdentityProfileQuery
} from "./query-signals.js";
import { inferExactDetailQuestionFamily } from "./exact-detail-question-family.js";
import {
  isReasonedProfileJudgmentQueryText,
  resolveTypedContractFromPlan
} from "./typed-contract-registry.js";
import {
  extractPrimaryQuerySurfaceNames,
  extractQuerySurfaceNames
} from "./query-subjects.js";
import { evaluateTypedContractCompleteness } from "./typed-contract-completeness.js";
import type {
  AnswerRetrievalPlan,
  RecallResponse,
  SubjectPlan
} from "./types.js";
import type { RecallResult } from "../types.js";

export interface PlannerTargetedBackfillNeed {
  readonly needed: boolean;
  readonly reason: string | null;
  readonly requiredFields: readonly string[];
  readonly completenessScore: number;
}

function isFirstPersonQueryText(queryText: string): boolean {
  return /\b(?:my|mine|me|i|i'm|i’ve|i've|i’d|i'd|i’ll|i'll)\b/iu.test(queryText);
}

function resolveBackfillSubjectLabel(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly subjectHints: readonly string[];
  readonly primaryQuerySubjects: readonly string[];
}): string {
  const namedSubject =
    params.primaryQuerySubjects[0] ??
    params.retrievalPlan.subjectNames[0] ??
    params.subjectHints[0] ??
    null;
  if (namedSubject) {
    return namedSubject;
  }
  if (isFirstPersonQueryText(params.queryText)) {
    return "I";
  }
  return "the person";
}

function buildExactDetailBackfillProbe(queryText: string, subject: string): string {
  const family = inferExactDetailQuestionFamily(queryText);
  const subjectPossessive = subject === "I" ? "my" : `${subject}'s`;
  const subjectObject = subject === "I" ? "me" : subject;
  switch (family) {
    case "pet_name":
      return `what is the exact name of ${subjectPossessive} pet?`;
    case "brand":
      return `which brand is explicitly named for ${subjectPossessive} running shoes?`;
    case "count":
      return `how many items are explicitly said to belong to ${subjectObject}?`;
    case "service_name":
      return subject === "I"
        ? "which exact streaming, music, or subscription service am I using?"
        : `which exact streaming, music, or subscription service is ${subject} using?`;
    case "shop":
      return subject === "I"
        ? "which store, shop, or retailer is explicitly named for my purchase?"
        : `which store, shop, or retailer is explicitly named for that purchase by ${subject}?`;
    case "venue":
      return subject === "I"
        ? "which school, venue, campus, or place is explicitly named for me?"
        : `which school, venue, campus, or place is explicitly named for ${subject}?`;
    case "certification":
      return subject === "I"
        ? "which certification, certificate, course, or program did I complete?"
        : `which certification, certificate, course, or program did ${subject} complete?`;
    case "capacity":
      return subject === "I"
        ? "what exact storage or memory capacity is explicitly named for me?"
        : `what exact storage or memory capacity is explicitly named for ${subject}?`;
    case "speed":
      return subject === "I"
        ? "what exact internet or plan speed is explicitly named for me?"
        : `what exact internet or plan speed is explicitly named for ${subject}?`;
    case "time_of_day":
      return subject === "I"
        ? "what exact time of day is explicitly mentioned for me?"
        : `what exact time of day is explicitly mentioned for ${subject}?`;
    case "duration":
      return subject === "I"
        ? "what exact duration is explicitly mentioned for me?"
        : `what exact duration is explicitly mentioned for ${subject}?`;
    case "role":
      return subject === "I"
        ? "what exact role, job, or occupation is explicitly named for me?"
        : `what exact role, job, or occupation is explicitly named for ${subject}?`;
    default:
      return `which exact named value answers: ${queryText.trim().replace(/\?+$/u, "")}?`;
  }
}

function isCompanionScopedIndoorActivityInventoryQuery(queryText: string): boolean {
  return (
    /\bindoor activities?\b/iu.test(queryText) &&
    /\bwith\b[^?!.]{0,40}\b(?:girlfriend|boyfriend|wife|husband|partner|fianc[eé]|fiancée|gf|bf)\b/iu.test(queryText)
  );
}

export function buildPlannerBackfillSubjectPlan(
  queryText: string,
  retrievalPlan: AnswerRetrievalPlan,
  subjectHints: readonly string[]
): SubjectPlan {
  const pairNames = retrievalPlan.subjectNames.length >= 2 ? retrievalPlan.subjectNames.slice(0, 2) : [];
  if (pairNames.length >= 2) {
    return {
      kind: "pair_subject",
      subjectEntityId: null,
      canonicalSubjectName: pairNames[0] ?? null,
      pairSubjectEntityId: null,
      pairSubjectName: pairNames[1] ?? null,
      candidateEntityIds: [],
      candidateNames: pairNames,
      reason: `planner_targeted_backfill_pair_subject:${pairNames.join("|")}`
    };
  }
  const subjectName = retrievalPlan.subjectNames[0] ?? subjectHints[0] ?? null;
  return {
    kind: subjectName ? "single_subject" : "no_subject",
    subjectEntityId: null,
    canonicalSubjectName: subjectName,
    candidateEntityIds: [],
    candidateNames: subjectName ? [subjectName] : [],
    reason: subjectName ? "planner_targeted_backfill_subject" : "planner_targeted_backfill_no_subject"
  };
}

export function evaluateTypedContractBackfillNeed(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly results: readonly RecallResult[];
}): PlannerTargetedBackfillNeed | null {
  const typedContract = evaluateTypedContractCompleteness({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results
  });
  if (!typedContract) {
    return null;
  }
  return {
    needed: !typedContract.complete,
    reason: typedContract.backfillReason,
    requiredFields: typedContract.missingFields.length > 0 ? typedContract.missingFields : typedContract.requiredFields,
    completenessScore: typedContract.completenessScore
  };
}

export function buildTypedContractBackfillSubqueries(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly subjectHints: readonly string[];
  readonly reason: string | null;
}): readonly string[] | null {
  const { queryText, retrievalPlan, subjectHints, reason } = params;
  const primaryQuerySubjects = extractPrimaryQuerySurfaceNames(queryText);
  const surfaceSubjects = extractQuerySurfaceNames(queryText);
  const subject = resolveBackfillSubjectLabel({
    queryText,
    retrievalPlan,
    subjectHints,
    primaryQuerySubjects
  });
  const controllerContract = resolveTypedContractFromPlan({
    queryText,
    retrievalPlan
  });
  const trimmedQuery = queryText.trim().replace(/\?+$/u, "");
  const subqueries = new Set<string>();
  const exactHabitStartSpecificity =
    retrievalPlan.answerKind === "direct_attribute" &&
    reason === "exact_detail_support_specificity_missing" &&
    /\bhabit\b|\bstart\b|\bactivity\b/iu.test(queryText);
  if (exactHabitStartSpecificity) {
    return null;
  }
  switch (controllerContract ?? retrievalPlan.answerKind) {
    case "utterance_fact":
      subqueries.add(`${trimmedQuery}?`);
      subqueries.add(`which statement by ${subject} directly mentions ${trimmedQuery.replace(/^what did\s+.+?\s+say\s+about\s+/iu, "").trim()}?`);
      break;
    case "direct_reason":
    case "structured_direct_reason":
    case "benefit_reason_slot":
      subqueries.add(`${trimmedQuery}?`);
      subqueries.add(
        controllerContract === "benefit_reason_slot"
          ? `which line directly states what ${subject} found helpful, motivating, inspiring, or great for them?`
          : `which line directly states ${subject}'s reason?`
      );
      break;
    case "value_slot":
    case "symbolic_value_slot":
    case "direct_attribute":
    case "temporal_plan_detail":
      subqueries.add(`${trimmedQuery}?`);
      subqueries.add(buildExactDetailBackfillProbe(queryText, subject));
      break;
    case "list_history":
    case "book_list":
    case "book_recommendation_pair":
      if (!isConcreteBookHistoryQuery(queryText)) {
        return null;
      }
      if (controllerContract === "book_recommendation_pair") {
        const pairSubject =
          surfaceSubjects.find((name) => name !== subject) ??
          retrievalPlan.subjectNames.find((name) => name !== subject) ??
          subjectHints.find((name) => name !== subject) ??
          "Caroline";
        subqueries.add(`what book did ${subject} read from ${pairSubject}'s suggestion?`);
        subqueries.add(`which book did ${pairSubject} recommend to ${subject}?`);
      } else {
        subqueries.add(`what books has ${subject} read?`);
        subqueries.add(`which book titles are explicitly mentioned for ${subject}?`);
      }
      break;
    case "inventory_list":
    case "made_item_pair_inventory":
    case "pet_inventory":
      subqueries.add(`${trimmedQuery}?`);
      if (controllerContract === "made_item_pair_inventory") {
        const pairSubject = retrievalPlan.subjectNames[1] ?? subjectHints[1] ?? "their family";
        subqueries.add(`which named painted or pottery items are explicitly mentioned for ${subject} and ${pairSubject}?`);
      } else if (controllerContract === "pet_inventory") {
        subqueries.add(`which pet types are explicitly mentioned for ${subject}?`);
      } else if (isConcretePaintedItemQuery(queryText)) {
        subqueries.add(`which painted subjects or items are explicitly named for ${subject}?`);
      } else if (isConcretePotteryItemQuery(queryText)) {
        subqueries.add(`which pottery items or pieces are explicitly named for ${subject}?`);
      } else if (isConcreteInstrumentInventoryQuery(queryText)) {
        subqueries.add(`which instruments are explicitly mentioned for ${subject}?`);
      } else if (isConcreteMusicArtistHistoryQuery(queryText)) {
        subqueries.add(`which bands or musical artists are explicitly mentioned for ${subject}?`);
      } else if (isConcretePetNameQuery(queryText)) {
        subqueries.add(`which pet names are explicitly mentioned for ${subject}?`);
      } else if (isConcreteSymbolInventoryQuery(queryText)) {
        subqueries.add(`which named symbols or symbolic items are explicitly mentioned for ${subject}?`);
      } else {
        subqueries.add(`which named items are explicitly mentioned for ${subject}?`);
      }
      break;
    case "location_history":
    case "camping_location_history":
      if (isConcreteLocationHistoryQuery(queryText)) {
        subqueries.add(`${trimmedQuery}?`);
        if (controllerContract === "camping_location_history" || /\bcamp(?:ed|ing)?\b/iu.test(queryText)) {
          subqueries.add(`which camping locations are explicitly named for ${subject}?`);
          subqueries.add(`which outdoor places, campsites, or nature settings are explicitly mentioned for ${subject}'s camping trips?`);
        } else {
          subqueries.add(`which locations are explicitly named for ${subject}?`);
        }
      }
      break;
    case "event_inventory":
    case "family_activity_inventory":
    case "pair_event_inventory":
    case "direct_destress_activity":
      if (isConcreteEventInventoryQuery(queryText) || isFamilyActivityInventoryQuery(queryText)) {
        if (isCompanionScopedIndoorActivityInventoryQuery(queryText)) {
          subqueries.add(`what indoor activities has ${subject} done with his girlfriend?`);
          subqueries.add(`which indoor activities like board games, wine tasting, volunteering, or taking care of flowers are explicitly mentioned for ${subject}?`);
          break;
        }
        if (/\bhelp\s+(?:children|kids|youth|young people)\b/iu.test(queryText)) {
          subqueries.add(`${trimmedQuery}?`);
          subqueries.add(`which child-help events like mentoring programs or school speeches are explicitly mentioned for ${subject}?`);
          break;
        }
        if (/\bin what ways\b/iu.test(queryText) && /\blgbtq\+?\b|\bcommunity\b/iu.test(queryText)) {
          subqueries.add(`${trimmedQuery}?`);
          subqueries.add(`which LGBTQ community participation activities like joining an activist group, pride events, art shows, or mentoring are explicitly mentioned for ${subject}?`);
          break;
        }
        if (/\bwhat\s+(?:lgbtq\+?\s+)?events?\b/iu.test(queryText)) {
          subqueries.add(`${trimmedQuery}?`);
          subqueries.add(`which LGBTQ events like pride parades, support groups, or school speeches are explicitly mentioned for ${subject}?`);
          break;
        }
        if (controllerContract === "pair_event_inventory") {
          const pairSubject = retrievalPlan.subjectNames[1] ?? subjectHints[1] ?? "Melanie";
          subqueries.add(`${trimmedQuery}?`);
          subqueries.add(`which shared events or activities are explicitly mentioned for ${subject} and ${pairSubject}?`);
        } else {
          subqueries.add(`${trimmedQuery}?`);
          subqueries.add(
            controllerContract === "family_activity_inventory"
              ? `which family, hiking, camping, or workshop activities are explicitly mentioned for ${subject}?`
              : /\bactivities?\b|\bpartake\b|\bhobbies?\b/iu.test(queryText)
                ? `which hobbies or recurring activities are explicitly mentioned for ${subject}?`
              : `which event or activity names are explicitly mentioned for ${subject}?`
          );
        }
      } else if (controllerContract === "direct_destress_activity") {
        subqueries.add(`what activities does ${subject} do to destress?`);
        subqueries.add(`which stress-relief activities are explicitly mentioned for ${subject}?`);
      }
      break;
    case "support_network":
      if (isConcreteSupportNetworkQuery(queryText)) {
        subqueries.add(`${trimmedQuery}?`);
        subqueries.add(`which friends, family members, or mentors explicitly support ${subject}?`);
      }
      break;
    case "identity_profile":
    case "report_inference":
      if (!isIdentityProfileQuery(queryText) && controllerContract !== "identity_profile") {
        return null;
      }
      subqueries.add(`what identity does ${subject} explicitly describe?`);
      subqueries.add(`what does ${subject} say about gender identity or being transgender, nonbinary, or queer?`);
      break;
    case "made_item_inventory":
      subqueries.add(`${trimmedQuery}?`);
      subqueries.add(`which named items or pieces did ${subject} explicitly make or design?`);
      break;
    case "relationship_profile":
      subqueries.add(`what is ${subject}'s relationship status?`);
      subqueries.add(`is ${subject} explicitly described as single, dating, married, or in a relationship, including single-parent or breakup cues?`);
      break;
    case "preference_profile":
      subqueries.add(`${trimmedQuery}?`);
      if (/\bkids?\b|\bchildren\b/iu.test(queryText)) {
        subqueries.add(`what do ${subject}'s kids explicitly like or get excited about?`);
        subqueries.add(`which favorites, interests, or things ${subject}'s kids love are explicitly mentioned?`);
      } else {
        subqueries.add(`which explicit likes, favorites, or preferences are mentioned for ${subject}?`);
      }
      break;
    case "profile_trait_judgment":
      subqueries.add(`${trimmedQuery}?`);
      subqueries.add(`which explicit statements describe ${subject}'s traits, beliefs, or likely preferences?`);
      break;
    case "reasoned_profile_judgment":
      if (!isReasonedProfileJudgmentQueryText(queryText)) {
        return null;
      }
      subqueries.add(`${trimmedQuery}?`);
      if (/\bhadn'?t\b[^?!.]{0,80}\bsupport\b|\bwithout support\b|\bgrowing up\b/iu.test(queryText)) {
        subqueries.add(`which explicit statements link ${subject}'s support growing up to their counseling or mental-health career interest?`);
      } else {
        subqueries.add(`which explicit reasons or plans suggest whether ${subject} would pursue that career path?`);
      }
      break;
    default:
      return null;
  }
  return subqueries.size > 0 ? [...subqueries].slice(0, 2) : null;
}

export function buildTypedCompletionFollowupSubqueries(params: {
  readonly queryText: string;
  readonly retrievalPlan: AnswerRetrievalPlan;
  readonly subjectHints: readonly string[];
  readonly results: readonly RecallResult[];
  readonly answerAssessment?: Pick<
    NonNullable<RecallResponse["meta"]["answerAssessment"]>,
    "sufficiency" | "subjectMatch" | "matchedParticipants"
  > | null;
}): readonly string[] | null {
  const completeness = evaluateTypedContractCompleteness({
    queryText: params.queryText,
    retrievalPlan: params.retrievalPlan,
    results: params.results,
    answerAssessment: params.answerAssessment
  });
  if (!completeness || completeness.complete) {
    return null;
  }
  const subject =
    params.retrievalPlan.subjectNames[0] ??
    params.subjectHints[0] ??
    (isFirstPersonQueryText(params.queryText) ? "I" : "the person");
  const primaryQuerySubjects = extractPrimaryQuerySurfaceNames(params.queryText);
  const effectiveSubject = primaryQuerySubjects[0] ?? subject;
  switch (completeness.contract) {
    case "book_list":
      return [
        `what other books has ${subject} read?`,
        `which additional book titles are explicitly mentioned for ${subject}?`
      ];
    case "event_inventory":
    case "family_activity_inventory":
    case "pair_event_inventory":
    case "direct_destress_activity":
      if (isCompanionScopedIndoorActivityInventoryQuery(params.queryText)) {
        return [
          `what other indoor activities has ${subject} done with his girlfriend?`,
          `which additional indoor activities like board games, wine tasting, volunteering, or taking care of flowers are explicitly mentioned for ${subject}?`
        ];
      }
      return [
        completeness.contract === "direct_destress_activity"
          ? `what else does ${subject} do to destress?`
          : completeness.contract === "family_activity_inventory"
            ? `what other family, hiking, camping, or workshop activities are explicitly mentioned for ${subject}?`
          : /\bactivities?\b|\bpartake\b|\bhobbies?\b/iu.test(params.queryText)
            ? `what other hobbies or recurring activities are explicitly mentioned for ${subject}?`
          : completeness.contract === "pair_event_inventory"
            ? `what other shared events or activities involved ${subject} and ${params.retrievalPlan.subjectNames[1] ?? params.subjectHints[1] ?? "Melanie"}?`
          : `what other events or activities has ${subject} participated in?`,
        completeness.contract === "direct_destress_activity"
          ? `which additional stress-relief activities are explicitly mentioned for ${subject}?`
          : completeness.contract === "family_activity_inventory"
            ? `which additional family, hiking, camping, or workshop activities are explicitly mentioned for ${subject}?`
          : /\bactivities?\b|\bpartake\b|\bhobbies?\b/iu.test(params.queryText)
            ? `which additional hobbies or recurring activity names are explicitly mentioned for ${subject}?`
          : completeness.contract === "pair_event_inventory"
            ? `which additional shared event or activity names are explicitly mentioned for ${subject} and ${params.retrievalPlan.subjectNames[1] ?? params.subjectHints[1] ?? "Melanie"}?`
          : `which additional event or activity names are explicitly mentioned for ${subject}?`
      ];
    case "camping_location_history":
      return [
        `where else has ${subject} camped?`,
        `which additional camping locations, campsites, or outdoor settings are explicitly named for ${subject}?`
      ];
    case "location_history":
      return [
        `where else has ${subject} been?`,
        `which additional locations are explicitly named for ${subject}?`
      ];
    case "support_network":
      return [
        `who else explicitly supports ${subject}?`,
        `which other friends, family members, or mentors are mentioned as supporting ${subject}?`
      ];
    case "preference_profile":
      return /\bkids?\b|\bchildren\b/iu.test(params.queryText)
        ? [
            `what do ${subject}'s kids explicitly like or get excited about?`,
            `which additional favorites, interests, or things ${subject}'s kids love are mentioned?`
          ]
        : [
            `what does ${subject} explicitly like or prefer?`,
            `which explicit preferences or favorites are mentioned for ${subject}?`
          ];
    case "profile_trait_judgment":
      return [
        `what explicit statements describe ${subject}'s traits, beliefs, or likely preferences?`,
        `which lines directly support whether ${subject} would like that, move back, or be considered religious?`
      ];
    case "reasoned_profile_judgment":
      return /\bhadn'?t\b[^?!.]{0,80}\bsupport\b|\bwithout support\b|\bgrowing up\b/iu.test(params.queryText)
        ? [
            `what explicit support or growing-up experiences shaped ${subject}'s counseling or mental-health career interest?`,
            `which plans, guidance, or support statements connect to ${subject}'s career goals?`
          ]
        : [
            `what explicit reasons suggest whether ${subject} would pursue that career path?`,
            `which plans, interests, or statements support that judgment for ${subject}?`
          ];
    case "made_item_pair_inventory":
      return [
        `what other painted or pottery items are explicitly mentioned for ${subject} and ${params.retrievalPlan.subjectNames[1] ?? params.subjectHints[1] ?? "their family"}?`,
        `which additional named pieces or subjects were made by ${subject} and ${params.retrievalPlan.subjectNames[1] ?? params.subjectHints[1] ?? "their family"}?`
      ];
    case "pet_inventory":
      return [
        `what other pets does ${subject} have?`,
        `which additional pet types are explicitly mentioned for ${subject}?`
      ];
    case "benefit_reason_slot":
      return [
        `what else does ${subject} describe as helpful, motivating, inspiring, or great for them?`,
        `which exact lines state that benefit or effect for ${subject}?`
      ];
    case "book_recommendation_pair": {
      const pairSubject =
        extractQuerySurfaceNames(params.queryText).find((name) => name !== effectiveSubject) ??
        params.retrievalPlan.subjectNames.find((name) => name !== effectiveSubject) ??
        params.subjectHints.find((name) => name !== effectiveSubject) ??
        "Caroline";
      return [
        `what other book was recommended by ${pairSubject} to ${effectiveSubject}?`,
        `which explicit recommendation links ${pairSubject} and ${effectiveSubject} to a named book?`
      ];
    }
    default:
      return null;
  }
}
