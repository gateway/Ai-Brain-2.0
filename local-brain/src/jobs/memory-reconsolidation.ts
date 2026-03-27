import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/client.js";
import { linkDerivedProfileSnapshot } from "./memory-graph.js";
import { searchMemory } from "../retrieval/service.js";
import type { RecallConfidenceGrade } from "../retrieval/types.js";
import type { RecallResult } from "../types.js";

export interface MemoryReconsolidationSummary {
  readonly runId: string;
  readonly namespaceId: string;
  readonly query: string;
  readonly priorConfidence: RecallConfidenceGrade;
  readonly action: "add" | "update" | "supersede" | "abstain" | "skip";
  readonly semanticMemoryId?: string;
  readonly reason: string;
}

export interface RunMemoryReconsolidationInput {
  readonly namespaceId: string;
  readonly query: string;
  readonly timeStart?: string;
  readonly timeEnd?: string;
  readonly limit?: number;
}

interface RelationshipProfileStateRow {
  readonly semantic_id: string | null;
  readonly content_abstract: string | null;
  readonly person_name: string;
  readonly partner_name: string | null;
  readonly source_memory_id: string | null;
  readonly relationship_memory_id: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly relationship_transition: string | null;
}

interface BeliefProfileStateRow {
  readonly semantic_id: string | null;
  readonly content_abstract: string | null;
  readonly person_name: string;
  readonly topic: string;
  readonly belief_text: string;
  readonly source_memory_id: string | null;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly prior_belief_text: string | null;
  readonly prior_valid_until: string | null;
}

interface MutableProceduralStateRow {
  readonly id: string;
  readonly state_type: string;
  readonly state_key: string;
  readonly state_value: Record<string, unknown>;
  readonly valid_from: string;
}

type DerivedProfileKind =
  | "identity_summary"
  | "current_picture"
  | "focus"
  | "role_direction"
  | "interest_pattern"
  | "social_pattern"
  | "relationship_status"
  | "project_status";

type DerivedNoteFamily = "fact_note" | "profile_note" | "preference_note";

interface DerivedProfileCandidate {
  readonly personName: string;
  readonly profileKind: DerivedProfileKind;
  readonly canonicalKey: string;
  readonly content: string;
  readonly validFrom: string;
  readonly sourceEpisodicId: string | null;
  readonly relationshipMemoryId?: string | null;
  readonly supportProceduralIds: readonly string[];
  readonly supportEpisodicIds: readonly string[];
  readonly supportStateTypes: readonly string[];
  readonly supportStateKeys: readonly string[];
}

export interface UniversalMutableReconsolidationSummary {
  readonly runId: string;
  readonly namespaceId: string;
  readonly added: number;
  readonly superseded: number;
  readonly retired: number;
  readonly abstained: number;
  readonly processedKeys: readonly string[];
}

function formatUtcDayLabel(isoStart: string): string {
  return new Date(isoStart).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function normalizeSummaryContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

function formatList(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0]!;
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function buildDaySummaryCanonicalKey(start: string): string {
  return `reconsolidated:day_summary:${start.slice(0, 10)}`;
}

function buildRelationshipProfileCanonicalKey(personName: string): string {
  return `reconsolidated:profile_summary:relationship:${personName.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`;
}

function normalizeBeliefTopic(topic: string): string {
  return normalizeSummaryContent(
    topic
      .toLowerCase()
      .replace(/^\s*using\s+/u, "")
      .replace(/\bfor\b/gu, " ")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
  ).replace(/\s+/gu, "_");
}

function buildBeliefProfileCanonicalKey(topic: string): string {
  return `reconsolidated:belief_summary:${normalizeBeliefTopic(topic).replace(/^_+|_+$/gu, "")}`;
}

function buildMutableStateSummaryCanonicalKey(stateType: string, stateKey: string): string {
  const normalizedStateType = normalizeSummaryContent(stateType.toLowerCase()).replace(/\s+/gu, "_");
  const normalizedStateKey = normalizeSummaryContent(stateKey.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `reconsolidated:state_summary:${normalizedStateType}:${normalizedStateKey}`;
}

function normalizePersonToken(personName: string): string {
  return personName.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function buildDerivedProfileCanonicalKey(profileKind: DerivedProfileKind, personName: string): string {
  return `reconsolidated:profile_summary:${profileKind}:${normalizePersonToken(personName)}`;
}

function noteFamilyForProfileKind(profileKind: DerivedProfileKind): DerivedNoteFamily {
  switch (profileKind) {
    case "interest_pattern":
      return "preference_note";
    case "relationship_status":
    case "project_status":
      return "fact_note";
    default:
      return "profile_note";
  }
}

function stateValueString(value: unknown): string {
  return typeof value === "string" ? normalizeSummaryContent(value) : "";
}

function buildMutableStateSummaryContent(row: MutableProceduralStateRow): string | null {
  const state = row.state_value ?? {};
  const person = stateValueString(state.person) || "Steve";
  const stateType = row.state_type;

  switch (stateType) {
    case "current_location": {
      const place = stateValueString(state.place) || stateValueString(state.place_name) || stateValueString(state.location);
      return place ? `${person} currently lives in ${place}.` : null;
    }
    case "current_employer": {
      const employer = stateValueString(state.organization) || stateValueString(state.employer) || stateValueString(state.company);
      return employer ? `${person} currently works at ${employer}.` : null;
    }
    case "current_project": {
      const project = stateValueString(state.project);
      return project ? `${person} is currently working on ${project}.` : null;
    }
    case "project_role": {
      const role = stateValueString(state.role);
      const project = stateValueString(state.project) || stateValueString(state.organization);
      if (role && project) {
        return `${person}'s current role is ${role} on ${project}.`;
      }
      return role ? `${person}'s current role is ${role}.` : null;
    }
    case "preference": {
      const target = stateValueString(state.target);
      const polarity = stateValueString(state.polarity);
      const category = stateValueString(state.category);
      if (!target || !polarity) {
        return null;
      }
      const relation = polarity === "dislike" ? "does not prefer" : "prefers";
      return `${person} ${relation} ${category ? `${category} ` : ""}${target}.`;
    }
    case "belief": {
      const topic = stateValueString(state.topic);
      const belief = stateValueString(state.belief);
      return topic && belief ? `${person}'s current stance on ${topic.toLowerCase()} is ${belief}.` : null;
    }
    case "goal": {
      const goal = stateValueString(state.goal);
      return goal ? `${person}'s current primary goal is ${goal}.` : null;
    }
    case "plan": {
      const plan = stateValueString(state.plan);
      return plan ? `${person}'s active plan is ${plan}.` : null;
    }
    case "constraint": {
      const constraint = stateValueString(state.constraint);
      return constraint ? `Current operational constraint: ${constraint}.` : null;
    }
    case "style_spec": {
      const styleSpec = stateValueString(state.style_spec);
      return styleSpec ? `Current style rule: ${styleSpec}.` : null;
    }
    case "decision": {
      const decision = stateValueString(state.decision);
      return decision ? `${person}'s active decision is ${decision}.` : null;
    }
    case "watchlist_item": {
      const title = stateValueString(state.title);
      return title ? `${person} currently wants to watch ${title}.` : null;
    }
    case "skill": {
      const skill = stateValueString(state.skill);
      return skill ? `${person} actively practices skill ${skill}.` : null;
    }
    case "routine": {
      const routine = stateValueString(state.routine);
      return routine ? `${person} currently has routine ${routine}.` : null;
    }
    case "current_relationship": {
      const partner = stateValueString(state.partner_name);
      return partner ? `${person} is currently dating ${partner}.` : `${person}'s current relationship status is unknown.`;
    }
    default:
      return null;
  }
}

function mutableStateSourceMemoryId(row: MutableProceduralStateRow): string | null {
  return typeof row.state_value?.source_memory_id === "string" && row.state_value.source_memory_id
    ? row.state_value.source_memory_id
    : null;
}

function mutableStateRelationshipMemoryId(row: MutableProceduralStateRow): string | null {
  return typeof row.state_value?.relationship_memory_id === "string" && row.state_value.relationship_memory_id
    ? row.state_value.relationship_memory_id
    : null;
}

function mutableStatePersonName(row: MutableProceduralStateRow): string {
  return stateValueString(row.state_value?.person) || "Steve";
}

function latestStateByType(rows: readonly MutableProceduralStateRow[], stateType: string): MutableProceduralStateRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.state_type === stateType) {
      return row;
    }
  }
  return null;
}

function rowsByType(rows: readonly MutableProceduralStateRow[], stateType: string): readonly MutableProceduralStateRow[] {
  return rows.filter((row) => row.state_type === stateType);
}

function listStateTargets(rows: readonly MutableProceduralStateRow[], stateType: string, extractor: (row: MutableProceduralStateRow) => string): readonly string[] {
  const values = new Set<string>();
  for (const row of rows) {
    if (row.state_type !== stateType) {
      continue;
    }
    const value = normalizeSummaryContent(extractor(row));
    if (value) {
      values.add(value);
    }
  }
  return [...values];
}

function buildDerivedProfileCandidates(activeStateRows: readonly MutableProceduralStateRow[]): readonly DerivedProfileCandidate[] {
  const rowsByPerson = new Map<string, MutableProceduralStateRow[]>();
  for (const row of activeStateRows) {
    const person = mutableStatePersonName(row);
    const existing = rowsByPerson.get(person) ?? [];
    existing.push(row);
    rowsByPerson.set(person, existing);
  }

  const candidates: DerivedProfileCandidate[] = [];
  for (const [personName, personRows] of rowsByPerson.entries()) {
    const currentEmployer = latestStateByType(personRows, "current_employer");
    const currentProject = latestStateByType(personRows, "current_project");
    const currentRole = latestStateByType(personRows, "project_role");
    const currentLocation = latestStateByType(personRows, "current_location");
    const currentRelationship = latestStateByType(personRows, "current_relationship");
    const currentGoal = latestStateByType(personRows, "goal");
    const currentPlan = latestStateByType(personRows, "plan");
    const currentConstraint = latestStateByType(personRows, "constraint");
    const currentDecision = latestStateByType(personRows, "decision");
    const preferences = rowsByType(personRows, "preference");
    const watchlist = rowsByType(personRows, "watchlist_item");
    const skills = rowsByType(personRows, "skill");
    const routines = rowsByType(personRows, "routine");
    const identityRows = rowsByType(personRows, "identity");

    const buildCandidate = (
      profileKind: DerivedProfileKind,
      content: string,
      supportRows: readonly MutableProceduralStateRow[]
    ): void => {
      const validSupportRows = supportRows.filter(Boolean);
      if (validSupportRows.length === 0) {
        return;
      }
      const normalizedContent = normalizeSummaryContent(content);
      if (!normalizedContent) {
        return;
      }
      const latestSupport = [...validSupportRows].sort((left, right) => left.valid_from.localeCompare(right.valid_from)).at(-1);
      if (!latestSupport) {
        return;
      }
      candidates.push({
        personName,
        profileKind,
        canonicalKey: buildDerivedProfileCanonicalKey(profileKind, personName),
        content: normalizedContent,
        validFrom: latestSupport.valid_from,
        sourceEpisodicId: mutableStateSourceMemoryId(latestSupport),
        relationshipMemoryId: validSupportRows.map((row) => mutableStateRelationshipMemoryId(row)).find((value) => typeof value === "string") ?? null,
        supportProceduralIds: validSupportRows.map((row) => row.id),
        supportEpisodicIds: [
          ...new Set(
            validSupportRows
              .map((row) => mutableStateSourceMemoryId(row))
              .filter((value): value is string => typeof value === "string" && value.length > 0)
          )
        ],
        supportStateTypes: [...new Set(validSupportRows.map((row) => row.state_type))],
        supportStateKeys: [...new Set(validSupportRows.map((row) => row.state_key))]
      });
    };

    const identitySegments: string[] = [];
    const identitySupport: MutableProceduralStateRow[] = [];
    const identityValues = listStateTargets(identityRows, "identity", (row) => {
      const identity = stateValueString(row.state_value.identity) || stateValueString(row.state_value.description);
      const qualifier = stateValueString(row.state_value.qualifier);
      if (identity && qualifier) {
        return `${identity} (${qualifier})`;
      }
      return identity;
    }).slice(0, 3);
    if (identityValues.length > 0) {
      identitySegments.push(...identityValues);
      identitySupport.push(...identityRows);
    }
    if (currentRole) {
      const role = stateValueString(currentRole.state_value.role);
      if (role) {
        identitySegments.push(`works as ${role}`);
        identitySupport.push(currentRole);
      }
    }
    if (currentEmployer) {
      const employer = stateValueString(currentEmployer.state_value.organization) || stateValueString(currentEmployer.state_value.employer) || stateValueString(currentEmployer.state_value.company);
      if (employer) {
        identitySegments.push(`at ${employer}`);
        identitySupport.push(currentEmployer);
      }
    }
    if (identitySegments.length > 0) {
      buildCandidate(
        "identity_summary",
        `${personName}'s current identity summary is ${formatList(identitySegments)}.`,
        identitySupport
      );
    }

    const currentPictureSegments: string[] = [];
    const currentPictureSupport: MutableProceduralStateRow[] = [];
    if (currentEmployer) {
      const employer = stateValueString(currentEmployer.state_value.organization) || stateValueString(currentEmployer.state_value.employer) || stateValueString(currentEmployer.state_value.company);
      if (employer) {
        currentPictureSegments.push(`works at ${employer}`);
        currentPictureSupport.push(currentEmployer);
      }
    }
    if (currentRole) {
      const role = stateValueString(currentRole.state_value.role);
      const project = stateValueString(currentRole.state_value.project) || stateValueString(currentRole.state_value.organization);
      if (role && project) {
        currentPictureSegments.push(`serves as ${role} on ${project}`);
        currentPictureSupport.push(currentRole);
      } else if (role) {
        currentPictureSegments.push(`currently holds the role ${role}`);
        currentPictureSupport.push(currentRole);
      }
    }
    if (currentProject) {
      const project = stateValueString(currentProject.state_value.project);
      if (project) {
        currentPictureSegments.push(`is focused on ${project}`);
        currentPictureSupport.push(currentProject);
      }
    }
    if (currentLocation) {
      const place = stateValueString(currentLocation.state_value.place) || stateValueString(currentLocation.state_value.place_name) || stateValueString(currentLocation.state_value.location);
      if (place) {
        currentPictureSegments.push(`lives in ${place}`);
        currentPictureSupport.push(currentLocation);
      }
    }
    if (currentRelationship) {
      const partnerName = stateValueString(currentRelationship.state_value.partner_name);
      if (partnerName) {
        currentPictureSegments.push(`is dating ${partnerName}`);
        currentPictureSupport.push(currentRelationship);
      }
    }
    if (currentPictureSegments.length > 0) {
      buildCandidate(
        "current_picture",
        `${personName}'s current picture is that ${formatList(currentPictureSegments)}.`,
        currentPictureSupport
      );
    }

    const focusSegments: string[] = [];
    const focusSupport: MutableProceduralStateRow[] = [];
    if (currentGoal) {
      const goal = stateValueString(currentGoal.state_value.goal);
      if (goal) {
        focusSegments.push(`primary goal is ${goal}`);
        focusSupport.push(currentGoal);
      }
    }
    if (currentPlan) {
      const plan = stateValueString(currentPlan.state_value.plan);
      if (plan) {
        focusSegments.push(`active plan is ${plan}`);
        focusSupport.push(currentPlan);
      }
    }
    if (currentDecision) {
      const decision = stateValueString(currentDecision.state_value.decision);
      if (decision) {
        focusSegments.push(`current decision is ${decision}`);
        focusSupport.push(currentDecision);
      }
    }
    if (currentConstraint) {
      const constraint = stateValueString(currentConstraint.state_value.constraint);
      if (constraint) {
        focusSegments.push(`working around constraint ${constraint}`);
        focusSupport.push(currentConstraint);
      }
    }
    if (currentProject) {
      const project = stateValueString(currentProject.state_value.project);
      if (project) {
        focusSegments.push(`working on ${project}`);
        focusSupport.push(currentProject);
      }
    }
    if (focusSegments.length > 0) {
      buildCandidate(
        "focus",
        `${personName} is currently focused on ${formatList(focusSegments)}.`,
        focusSupport
      );
    }

    const roleSegments: string[] = [];
    const roleSupport: MutableProceduralStateRow[] = [];
    if (currentRole) {
      const role = stateValueString(currentRole.state_value.role);
      if (role) {
        roleSegments.push(role);
        roleSupport.push(currentRole);
      }
    }
    if (currentEmployer) {
      const employer = stateValueString(currentEmployer.state_value.organization) || stateValueString(currentEmployer.state_value.employer) || stateValueString(currentEmployer.state_value.company);
      if (employer) {
        roleSegments.push(`at ${employer}`);
        roleSupport.push(currentEmployer);
      }
    }
    if (currentGoal) {
      const goal = stateValueString(currentGoal.state_value.goal);
      if (goal) {
        roleSegments.push(`with direction toward ${goal}`);
        roleSupport.push(currentGoal);
      }
    }
    if (roleSegments.length > 0) {
      buildCandidate(
        "role_direction",
        `${personName}'s current role direction centers on ${formatList(roleSegments)}.`,
        roleSupport
      );
    }

    const interestTargets = [
      ...listStateTargets(preferences, "preference", (row) => {
        const polarity = stateValueString(row.state_value.polarity);
        const target = stateValueString(row.state_value.target);
        if (!target) {
          return "";
        }
        return polarity === "dislike" ? `avoiding ${target}` : target;
      }),
      ...listStateTargets(watchlist, "watchlist_item", (row) => stateValueString(row.state_value.title)),
      ...listStateTargets(skills, "skill", (row) => stateValueString(row.state_value.skill)),
      ...listStateTargets(routines, "routine", (row) => stateValueString(row.state_value.routine))
    ].slice(0, 4);
    const interestSupport = [...preferences, ...watchlist, ...skills, ...routines];
    if (interestTargets.length >= 2) {
      buildCandidate(
        "interest_pattern",
        `${personName}'s recurring interests and preferences include ${formatList(interestTargets)}.`,
        interestSupport
      );
    }

    const socialSegments: string[] = [];
    const socialSupport: MutableProceduralStateRow[] = [];
    if (currentRelationship) {
      const partnerName = stateValueString(currentRelationship.state_value.partner_name);
      if (partnerName) {
        socialSegments.push(`dating ${partnerName}`);
        socialSupport.push(currentRelationship);
      }
    }
    if (routines.length > 0) {
      const routineValues = listStateTargets(routines, "routine", (row) => stateValueString(row.state_value.routine)).slice(0, 2);
      if (routineValues.length > 0) {
        socialSegments.push(`keeping routines like ${formatList(routineValues)}`);
        socialSupport.push(...routines);
      }
    }
    if (socialSegments.length > 0) {
      buildCandidate(
        "social_pattern",
        `${personName}'s current social pattern includes ${formatList(socialSegments)}.`,
        socialSupport
      );
    }

    if (currentRelationship) {
      const partnerName = stateValueString(currentRelationship.state_value.partner_name);
      const status =
        stateValueString(currentRelationship.state_value.relationship_status) ||
        stateValueString(currentRelationship.state_value.status) ||
        (partnerName ? `dating ${partnerName}` : "");
      if (status) {
        buildCandidate(
          "relationship_status",
          `${personName}'s current relationship status is ${status}.`,
          [currentRelationship]
        );
      }
    }

    if (currentProject) {
      const project = stateValueString(currentProject.state_value.project);
      const projectStatus =
        stateValueString(currentProject.state_value.status) ||
        stateValueString(currentProject.state_value.project_status) ||
        (project ? `working on ${project}` : "");
      if (projectStatus) {
        const projectSummary =
          project && !normalizeSummaryContent(projectStatus).includes(normalizeSummaryContent(project))
            ? `${project} (${projectStatus})`
            : projectStatus;
        buildCandidate(
          "project_status",
          `${personName}'s current project status is ${projectSummary}.`,
          [currentProject]
        );
      }
    }
  }

  return candidates;
}

function parseRelationshipProfileConsistencyQuery(query: string): string | null {
  const normalized = query.trim();
  if (!normalized) {
    return null;
  }

  const patterns = [
    /^check\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})['’]s\s+profile\s+summary\s+for\s+consistency\.?$/u,
    /^check\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s+profile\s+summary\s+for\s+consistency\.?$/u
  ] as const;

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function parseBeliefProfileConsistencyQuery(query: string): string | null {
  const normalized = query.trim();
  if (!normalized) {
    return null;
  }

  const patterns = [
    /^check\s+belief\s+summary\s+for\s+(.+?)\s+for\s+consistency\.?$/iu,
    /^check\s+.+['’]s\s+belief\s+summary\s+for\s+(.+?)\s+for\s+consistency\.?$/iu,
    /^check\s+(.+?)\s+belief\s+summary\s+for\s+consistency\.?$/iu
  ] as const;

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const topic = typeof match?.[1] === "string" ? normalizeSummaryContent(match[1]) : "";
    if (topic) {
      return topic.replace(/^\s*using\s+/iu, "");
    }
  }

  return null;
}

function isWeakOrMissing(confidence: RecallConfidenceGrade): boolean {
  return confidence === "weak" || confidence === "missing";
}

function hasAdequateEvidence(
  results: readonly RecallResult[],
  evidenceCount: number,
  inferredTimeStart?: string,
  inferredTimeEnd?: string
): boolean {
  if (!inferredTimeStart || !inferredTimeEnd) {
    return false;
  }

  if (evidenceCount === 0) {
    return false;
  }

  return results.some((result) => result.memoryType === "temporal_nodes" || result.memoryType === "narrative_event");
}

function formatRelationshipStatusSummary(state: RelationshipProfileStateRow): string {
  if (state.valid_until === null && state.partner_name) {
    return normalizeSummaryContent(`${state.person_name} is currently dating ${state.partner_name}.`);
  }

  const transitionDate = state.valid_until ?? state.valid_from;
  if (state.partner_name && transitionDate) {
    const formatted = new Date(transitionDate).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    });
    const transition =
      state.relationship_transition === "paused"
        ? "paused"
        : state.relationship_transition === "ended"
          ? "ended"
          : "changed";
    return normalizeSummaryContent(
      `${state.person_name}'s current relationship status is unknown. The latest confirmed relationship with ${state.partner_name} ${transition} on ${formatted}.`
    );
  }

  return normalizeSummaryContent(`${state.person_name}'s current relationship status is unknown.`);
}

function formatBeliefStatusSummary(state: BeliefProfileStateRow): string {
  const topicLower = normalizeSummaryContent(
    state.topic
      .toLowerCase()
      .replace(/^\s*using\s+/u, "")
      .replace(/\bfor\b/gu, " ")
      .replace(/-/gu, " ")
  );
  if (state.prior_belief_text && state.prior_valid_until) {
    const changedOn = new Date(state.prior_valid_until).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    });
    return normalizeSummaryContent(
      `${state.person_name}'s current stance on ${topicLower} is ${state.belief_text}. It changed on ${changedOn} from ${state.prior_belief_text}.`
    );
  }

  return normalizeSummaryContent(`${state.person_name}'s current stance on ${topicLower} is ${state.belief_text}.`);
}

async function loadRelationshipProfileState(
  namespaceId: string,
  personName: string
): Promise<RelationshipProfileStateRow | null> {
  return withTransaction(async (client) => {
    const currentState = await client.query<RelationshipProfileStateRow>(
      `
        SELECT
          NULL::uuid AS semantic_id,
          NULL::text AS content_abstract,
          subject_entity.canonical_name AS person_name,
          partner_entity.canonical_name AS partner_name,
          NULLIF(pm.state_value->>'source_memory_id', '')::uuid AS source_memory_id,
          NULLIF(pm.state_value->>'relationship_memory_id', '')::uuid AS relationship_memory_id,
          pm.valid_from::text AS valid_from,
          pm.valid_until::text AS valid_until,
          'active'::text AS relationship_transition
        FROM procedural_memory pm
        JOIN entities subject_entity
          ON subject_entity.id::text = pm.state_value->>'subject_entity_id'
        LEFT JOIN entities partner_entity
          ON partner_entity.id::text = pm.state_value->>'partner_entity_id'
        WHERE pm.namespace_id = $1
          AND pm.state_type = 'current_relationship'
          AND pm.valid_until IS NULL
          AND subject_entity.canonical_name = $2
        ORDER BY pm.updated_at DESC
        LIMIT 1
      `,
      [namespaceId, personName]
    );

    if (currentState.rows[0]) {
      return currentState.rows[0];
    }

    const historicalState = await client.query<RelationshipProfileStateRow>(
      `
        SELECT
          NULL::uuid AS semantic_id,
          NULL::text AS content_abstract,
          subject_entity.canonical_name AS person_name,
          partner_entity.canonical_name AS partner_name,
          NULLIF(rm.metadata->>'source_memory_id', '')::uuid AS source_memory_id,
          rm.id AS relationship_memory_id,
          rm.valid_from::text AS valid_from,
          rm.valid_until::text AS valid_until,
          coalesce(rm.metadata->>'relationship_transition', 'ended') AS relationship_transition
        FROM relationship_memory rm
        JOIN entities subject_entity ON subject_entity.id = rm.subject_entity_id
        JOIN entities partner_entity ON partner_entity.id = rm.object_entity_id
        WHERE rm.namespace_id = $1
          AND rm.predicate = 'significant_other_of'
          AND subject_entity.canonical_name = $2
        ORDER BY coalesce(rm.valid_until, rm.valid_from) DESC, rm.valid_from DESC
        LIMIT 1
      `,
      [namespaceId, personName]
    );

    return historicalState.rows[0] ?? null;
  });
}

async function loadExistingRelationshipProfileSummary(
  namespaceId: string,
  canonicalKey: string
): Promise<{ id: string; content_abstract: string } | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; content_abstract: string }>(
      `
        SELECT id, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [namespaceId, canonicalKey]
    );

    return result.rows[0] ?? null;
  });
}

async function loadBeliefProfileState(
  namespaceId: string,
  topic: string
): Promise<BeliefProfileStateRow | null> {
  const normalizedTopic = normalizeBeliefTopic(topic);
  return withTransaction(async (client) => {
    const result = await client.query<BeliefProfileStateRow>(
      `
        WITH current_beliefs AS (
          SELECT
            NULL::uuid AS semantic_id,
            NULL::text AS content_abstract,
            coalesce(pm.state_value->>'person', 'User') AS person_name,
            coalesce(pm.state_value->>'topic', pm.state_key) AS topic,
            coalesce(pm.state_value->>'belief', pm.state_key) AS belief_text,
            NULLIF(pm.state_value->>'source_memory_id', '')::uuid AS source_memory_id,
            pm.valid_from::text AS valid_from,
            pm.valid_until::text AS valid_until,
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(coalesce(pm.state_value->>'topic', '')), '^using\\s+', ''),
                '\\mfor\\M',
                ' ',
                'g'
              ),
              '[^a-z0-9]+',
              '_',
              'g'
            ) AS normalized_topic
          FROM procedural_memory pm
          WHERE pm.namespace_id = $1
            AND pm.state_type = 'belief'
            AND pm.valid_until IS NULL
          ORDER BY pm.updated_at DESC
        ),
        prior_beliefs AS (
          SELECT
            coalesce(pm.state_value->>'belief', pm.state_key) AS prior_belief_text,
            pm.valid_until::text AS prior_valid_until,
            regexp_replace(
              regexp_replace(
                regexp_replace(lower(coalesce(pm.state_value->>'topic', '')), '^using\\s+', ''),
                '\\mfor\\M',
                ' ',
                'g'
              ),
              '[^a-z0-9]+',
              '_',
              'g'
            ) AS normalized_topic
          FROM procedural_memory pm
          WHERE pm.namespace_id = $1
            AND pm.state_type = 'belief'
            AND pm.valid_until IS NOT NULL
          ORDER BY pm.valid_until DESC
        )
        SELECT
          cb.semantic_id,
          cb.content_abstract,
          cb.person_name,
          cb.topic,
          cb.belief_text,
          cb.source_memory_id,
          cb.valid_from,
          cb.valid_until,
          pb.prior_belief_text,
          pb.prior_valid_until
        FROM current_beliefs cb
        LEFT JOIN LATERAL (
          SELECT prior_belief_text, prior_valid_until
          FROM prior_beliefs
          WHERE normalized_topic = $2
          ORDER BY prior_valid_until DESC
          LIMIT 1
        ) pb ON TRUE
        WHERE cb.normalized_topic = $2
        ORDER BY cb.valid_from DESC
        LIMIT 1
      `,
      [namespaceId, normalizedTopic]
    );

    return result.rows[0] ?? null;
  });
}

async function loadExistingBeliefProfileSummary(
  namespaceId: string,
  canonicalKey: string
): Promise<{ id: string; content_abstract: string } | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; content_abstract: string }>(
      `
        SELECT id, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [namespaceId, canonicalKey]
    );

    return result.rows[0] ?? null;
  });
}

async function runRelationshipProfileReconsolidation(
  input: RunMemoryReconsolidationInput,
  personName: string
): Promise<MemoryReconsolidationSummary> {
  const runId = randomUUID();
  const canonicalKey = buildRelationshipProfileCanonicalKey(personName);
  const [relationshipState, existing] = await Promise.all([
    loadRelationshipProfileState(input.namespaceId, personName),
    loadExistingRelationshipProfileSummary(input.namespaceId, canonicalKey)
  ]);

  if (!relationshipState) {
    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            reason,
            metadata
          )
          VALUES ($1, $2, 'missing', 'skip', 'profile_summary', $3, $4::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          "Reconsolidation did not trigger because no relationship tenure state existed for the requested profile.",
          JSON.stringify({
            run_id: runId,
            person_name: personName,
            canonical_key: canonicalKey
          })
        ]
      );
    });

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "missing",
      action: "skip",
      reason: "No relationship tenure state existed for the requested profile."
    };
  }

  const nextContent = formatRelationshipStatusSummary(relationshipState);
  const effectiveTimestamp = relationshipState.valid_from ?? relationshipState.valid_until ?? new Date().toISOString();

  if (existing && normalizeSummaryContent(existing.content_abstract) === nextContent) {
    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            source_episodic_id,
            reason,
            metadata
          )
          VALUES ($1, $2, 'weak', 'abstain', 'profile_summary', $3::uuid, $4::uuid, $5, $6::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          existing.id,
          relationshipState.source_memory_id,
          "A matching relationship profile summary already existed.",
          JSON.stringify({
            run_id: runId,
            person_name: personName,
            canonical_key: canonicalKey
          })
        ]
      );
    });

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "weak",
      action: "abstain",
      semanticMemoryId: existing.id,
      reason: "Matching relationship profile summary already existed."
    };
  }

  return withTransaction(async (client) => {
    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.89, $3::timestamptz, NULL, 'active', true, $4::uuid, 'profile_summary', $5, $6::jsonb, $7::jsonb, true)
        RETURNING id
      `,
      [
        input.namespaceId,
        nextContent,
        effectiveTimestamp,
        relationshipState.source_memory_id,
        canonicalKey,
        JSON.stringify({
          person_name: relationshipState.person_name,
          partner_name: relationshipState.partner_name,
          relationship_memory_id: relationshipState.relationship_memory_id,
          relationship_transition: relationshipState.relationship_transition,
          valid_from: relationshipState.valid_from,
          valid_until: relationshipState.valid_until
        }),
        JSON.stringify({
          source: "memory_reconsolidation",
          run_id: runId,
          reconsolidation_kind: "relationship_profile",
          person_name: relationshipState.person_name,
          relationship_memory_id: relationshipState.relationship_memory_id
        })
      ]
    );

    const semanticMemoryId = insertResult.rows[0]?.id;
    if (!semanticMemoryId) {
      throw new Error("Failed to create reconsolidated relationship profile summary.");
    }

    let action: MemoryReconsolidationSummary["action"] = "add";
    let reason = "Added a relationship profile summary grounded in current-vs-historical tenure state.";

    if (existing) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2::timestamptz,
            status = 'superseded',
            superseded_by_id = $3::uuid
          WHERE id = $1
        `,
        [existing.id, effectiveTimestamp, semanticMemoryId]
      );
      action = "supersede";
      reason = "Superseded a stale relationship profile summary after state changed.";
    }

    await client.query(
      `
        INSERT INTO memory_reconsolidation_events (
          namespace_id,
          query_text,
          trigger_confidence,
          action,
          target_memory_kind,
          semantic_memory_id,
          source_episodic_id,
          reason,
          metadata
        )
        VALUES ($1, $2, 'weak', $3, 'profile_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
      `,
      [
        input.namespaceId,
        input.query,
        action,
        semanticMemoryId,
        relationshipState.source_memory_id,
        reason,
        JSON.stringify({
          run_id: runId,
          person_name: relationshipState.person_name,
          canonical_key: canonicalKey
        })
      ]
    );

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "weak",
      action,
      semanticMemoryId,
      reason
    };
  });
}

async function runBeliefProfileReconsolidation(
  input: RunMemoryReconsolidationInput,
  topic: string
): Promise<MemoryReconsolidationSummary> {
  const runId = randomUUID();
  const canonicalKey = buildBeliefProfileCanonicalKey(topic);
  const [beliefState, existing] = await Promise.all([
    loadBeliefProfileState(input.namespaceId, topic),
    loadExistingBeliefProfileSummary(input.namespaceId, canonicalKey)
  ]);

  if (!beliefState) {
    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "missing",
      action: "skip",
      reason: "No active belief state existed for the requested topic."
    };
  }

  const nextContent = formatBeliefStatusSummary(beliefState);
  const effectiveTimestamp = beliefState.valid_from ?? new Date().toISOString();

  if (existing && normalizeSummaryContent(existing.content_abstract) === nextContent) {
    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "weak",
      action: "abstain",
      semanticMemoryId: existing.id,
      reason: "Matching belief summary already existed."
    };
  }

  return withTransaction(async (client) => {
    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.88, $3::timestamptz, NULL, 'active', true, $4::uuid, 'belief_summary', $5, $6::jsonb, $7::jsonb, true)
        RETURNING id
      `,
      [
        input.namespaceId,
        nextContent,
        effectiveTimestamp,
        beliefState.source_memory_id,
        canonicalKey,
        JSON.stringify({
          topic: beliefState.topic,
          belief_text: beliefState.belief_text,
          prior_belief_text: beliefState.prior_belief_text,
          prior_valid_until: beliefState.prior_valid_until
        }),
        JSON.stringify({
          source: "memory_reconsolidation",
          run_id: runId,
          reconsolidation_kind: "belief_profile",
          topic: beliefState.topic
        })
      ]
    );

    const semanticMemoryId = insertResult.rows[0]?.id;
    if (!semanticMemoryId) {
      throw new Error("Failed to create reconsolidated belief summary.");
    }

    let action: MemoryReconsolidationSummary["action"] = "add";
    let reason = "Added a belief summary grounded in current-vs-historical belief state.";

    if (existing) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2::timestamptz,
            status = 'superseded',
            superseded_by_id = $3::uuid
          WHERE id = $1
        `,
        [existing.id, effectiveTimestamp, semanticMemoryId]
      );
      action = "supersede";
      reason = "Superseded a stale belief summary after state changed.";
    }

    await client.query(
      `
        INSERT INTO memory_reconsolidation_events (
          namespace_id,
          query_text,
          trigger_confidence,
          action,
          target_memory_kind,
          semantic_memory_id,
          source_episodic_id,
          reason,
          metadata
        )
        VALUES ($1, $2, 'weak', $3, 'belief_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
      `,
      [
        input.namespaceId,
        input.query,
        action,
        semanticMemoryId,
        beliefState.source_memory_id,
        reason,
        JSON.stringify({
          run_id: runId,
          canonical_key: canonicalKey,
          topic: beliefState.topic
        })
      ]
    );

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence: "weak",
      action,
      semanticMemoryId,
      reason
    };
  });
}

async function resolveSourceEpisodicId(
  namespaceId: string,
  artifactId: string | null | undefined,
  timeStart: string,
  timeEnd: string
): Promise<string | null> {
  if (!artifactId) {
    return null;
  }

  const row = await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM episodic_memory
        WHERE namespace_id = $1
          AND artifact_id = $2::uuid
          AND occurred_at >= $3::timestamptz
          AND occurred_at <= $4::timestamptz
        ORDER BY occurred_at ASC
        LIMIT 1
      `,
      [namespaceId, artifactId, timeStart, timeEnd]
    );

    return result.rows[0]?.id ?? null;
  });

  return row;
}

export async function runUniversalMutableReconsolidation(namespaceId: string): Promise<UniversalMutableReconsolidationSummary> {
  const runId = randomUUID();
  const processedKeys: string[] = [];

  return withTransaction(async (client) => {
    const activeStateRows = await client.query<MutableProceduralStateRow>(
      `
        SELECT id, state_type, state_key, state_value, valid_from::text
        FROM procedural_memory
        WHERE namespace_id = $1
          AND valid_until IS NULL
          AND state_type IN (
            'identity',
            'current_location',
            'current_employer',
            'current_project',
            'project_role',
            'preference',
            'belief',
            'goal',
            'plan',
            'constraint',
            'style_spec',
            'decision',
            'watchlist_item',
            'skill',
            'routine',
            'current_relationship'
          )
        ORDER BY valid_from ASC, updated_at ASC, id ASC
      `,
      [namespaceId]
    );

    const existingSummaryRows = await client.query<{
      id: string;
      canonical_key: string;
      content_abstract: string;
    }>(
      `
        SELECT id, canonical_key, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND memory_kind = 'state_summary'
          AND status = 'active'
          AND valid_until IS NULL
      `,
      [namespaceId]
    );
    const existingProfileRows = await client.query<{
      id: string;
      canonical_key: string;
      content_abstract: string;
    }>(
      `
        SELECT id, canonical_key, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND memory_kind = 'profile_summary'
          AND status = 'active'
          AND valid_until IS NULL
          AND (
            canonical_key LIKE 'reconsolidated:profile_summary:identity_summary:%'
            OR
            canonical_key LIKE 'reconsolidated:profile_summary:current_picture:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:focus:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:role_direction:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:interest_pattern:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:social_pattern:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:relationship_status:%'
            OR canonical_key LIKE 'reconsolidated:profile_summary:project_status:%'
          )
      `,
      [namespaceId]
    );

    const existingByKey = new Map(existingSummaryRows.rows.map((row) => [row.canonical_key, row] as const));
    const existingProfileByKey = new Map(existingProfileRows.rows.map((row) => [row.canonical_key, row] as const));
    const activeKeys = new Set<string>();
    const activeProfileKeys = new Set<string>();
    let added = 0;
    let superseded = 0;
    let retired = 0;
    let abstained = 0;

    for (const row of activeStateRows.rows) {
      const summaryContent = buildMutableStateSummaryContent(row);
      if (!summaryContent) {
        continue;
      }

      const canonicalKey = buildMutableStateSummaryCanonicalKey(row.state_type, row.state_key);
      activeKeys.add(canonicalKey);
      processedKeys.push(canonicalKey);

      const existing = existingByKey.get(canonicalKey);
      if (existing && normalizeSummaryContent(existing.content_abstract) === normalizeSummaryContent(summaryContent)) {
        abstained += 1;
        continue;
      }

      const insertResult = await client.query<{ id: string }>(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.86, $3::timestamptz, NULL, 'active', true, $4::uuid, 'state_summary', $5, $6::jsonb, $7::jsonb, true)
          RETURNING id
        `,
        [
          namespaceId,
          summaryContent,
          row.valid_from,
          mutableStateSourceMemoryId(row),
          canonicalKey,
          JSON.stringify({
            state_type: row.state_type,
            state_key: row.state_key,
            state_value: row.state_value
          }),
          JSON.stringify({
            source: "memory_reconsolidation",
            run_id: runId,
            reconsolidation_kind: "mutable_state",
            procedural_memory_id: row.id,
            state_type: row.state_type,
            state_key: row.state_key
          })
        ]
      );

      const semanticMemoryId = insertResult.rows[0]?.id;
      if (!semanticMemoryId) {
        throw new Error(`Failed to create mutable state summary for ${row.state_type}:${row.state_key}.`);
      }

      added += 1;

      if (existing) {
        await client.query(
          `
            UPDATE semantic_memory
            SET
              valid_until = $2::timestamptz,
              status = 'superseded',
              superseded_by_id = $3::uuid
            WHERE id = $1
          `,
          [existing.id, row.valid_from, semanticMemoryId]
        );
        superseded += 1;
      }

      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            source_episodic_id,
            reason,
            metadata
          )
          VALUES ($1, $2, 'weak', $3, 'state_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
        `,
        [
          namespaceId,
          `reconcile mutable state summary for ${row.state_type}:${row.state_key}`,
          existing ? "supersede" : "add",
          semanticMemoryId,
          mutableStateSourceMemoryId(row),
          existing
            ? `Superseded stale mutable state summary for ${row.state_type}:${row.state_key}.`
            : `Added mutable state summary for ${row.state_type}:${row.state_key}.`,
          JSON.stringify({
            run_id: runId,
            canonical_key: canonicalKey,
            state_type: row.state_type,
            state_key: row.state_key
          })
        ]
      );
    }

    const derivedProfileCandidates = buildDerivedProfileCandidates(activeStateRows.rows);
    for (const candidate of derivedProfileCandidates) {
      const noteFamily = noteFamilyForProfileKind(candidate.profileKind);
      activeProfileKeys.add(candidate.canonicalKey);
      processedKeys.push(candidate.canonicalKey);
      const existing = existingProfileByKey.get(candidate.canonicalKey);
      if (existing && normalizeSummaryContent(existing.content_abstract) === candidate.content) {
        abstained += 1;
        await client.query(
          `
            INSERT INTO memory_reconsolidation_events (
              namespace_id,
              query_text,
              trigger_confidence,
              action,
              target_memory_kind,
              semantic_memory_id,
              source_episodic_id,
              reason,
              metadata
            )
            VALUES ($1, $2, 'weak', 'abstain', 'profile_summary', $3::uuid, $4::uuid, $5, $6::jsonb)
          `,
          [
            namespaceId,
            `reinforce profile summary for ${candidate.profileKind}:${candidate.personName}`,
            existing.id,
            candidate.sourceEpisodicId,
            `A matching ${candidate.profileKind} profile summary already existed.`,
            JSON.stringify({
              run_id: runId,
              canonical_key: candidate.canonicalKey,
              person_name: candidate.personName,
              profile_kind: candidate.profileKind,
              note_family: noteFamily,
              adjudication_action: "reinforce",
              reconsolidation_decision: "reinforce",
              support_episodic_ids: candidate.supportEpisodicIds,
              support_procedural_ids: candidate.supportProceduralIds,
              support_state_types: candidate.supportStateTypes,
              support_state_keys: candidate.supportStateKeys
            })
          ]
        );
        continue;
      }

      const insertResult = await client.query<{ id: string }>(
        `
          INSERT INTO semantic_memory (
            namespace_id,
            content_abstract,
            importance_score,
            valid_from,
            valid_until,
            status,
            is_anchor,
            source_episodic_id,
            memory_kind,
            canonical_key,
            normalized_value,
            metadata,
            decay_exempt
          )
          VALUES ($1, $2, 0.87, $3::timestamptz, NULL, 'active', true, $4::uuid, 'profile_summary', $5, $6::jsonb, $7::jsonb, true)
          RETURNING id
        `,
        [
          namespaceId,
          candidate.content,
          candidate.validFrom,
          candidate.sourceEpisodicId,
          candidate.canonicalKey,
          JSON.stringify({
            person_name: candidate.personName,
            profile_kind: candidate.profileKind,
            note_family: noteFamily,
            support_episodic_ids: candidate.supportEpisodicIds,
            support_procedural_ids: candidate.supportProceduralIds,
            support_state_types: candidate.supportStateTypes,
            support_state_keys: candidate.supportStateKeys,
            supersession_lineage: existing?.id ? [existing.id] : []
          }),
          JSON.stringify({
            source: "memory_reconsolidation",
            run_id: runId,
            reconsolidation_kind: "derived_profile_snapshot",
            adjudication_action: existing ? "update" : "add",
            reconsolidation_decision: existing ? "update" : "add",
            source_family: "derived_profile_snapshot",
            person_name: candidate.personName,
            profile_kind: candidate.profileKind,
            note_family: noteFamily,
            support_episodic_ids: candidate.supportEpisodicIds,
            support_procedural_ids: candidate.supportProceduralIds
          })
        ]
      );

      const semanticMemoryId = insertResult.rows[0]?.id;
      if (!semanticMemoryId) {
        throw new Error(`Failed to create derived profile summary for ${candidate.profileKind}:${candidate.personName}.`);
      }

      await linkDerivedProfileSnapshot(client, {
        namespaceId,
        semanticMemoryId,
        sourceEpisodicId: candidate.sourceEpisodicId,
        supportProceduralIds: candidate.supportProceduralIds,
        relationshipMemoryId: candidate.relationshipMemoryId,
        supersedesSemanticId: existing?.id ?? null,
        profileKind: candidate.profileKind
      });

      added += 1;
      let eventAction: "add" | "supersede" = "add";
      let reason = `Added ${candidate.profileKind} profile summary for ${candidate.personName}.`;

      if (existing) {
        await client.query(
          `
            UPDATE semantic_memory
            SET
              valid_until = $2::timestamptz,
              status = 'superseded',
              superseded_by_id = $3::uuid
            WHERE id = $1
          `,
          [existing.id, candidate.validFrom, semanticMemoryId]
        );
        superseded += 1;
        eventAction = "supersede";
        reason = `Superseded stale ${candidate.profileKind} profile summary for ${candidate.personName}.`;
      }

      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            source_episodic_id,
            reason,
            metadata
          )
          VALUES ($1, $2, 'weak', $3, 'profile_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
        `,
        [
          namespaceId,
          `reconcile profile summary for ${candidate.profileKind}:${candidate.personName}`,
          eventAction,
          semanticMemoryId,
          candidate.sourceEpisodicId,
          reason,
          JSON.stringify({
            run_id: runId,
            canonical_key: candidate.canonicalKey,
            person_name: candidate.personName,
            profile_kind: candidate.profileKind,
            note_family: noteFamily,
            adjudication_action: existing ? "update" : "add",
            reconsolidation_decision: existing ? "update" : "add",
            support_episodic_ids: candidate.supportEpisodicIds,
            support_procedural_ids: candidate.supportProceduralIds,
            support_state_types: candidate.supportStateTypes,
            support_state_keys: candidate.supportStateKeys,
            supersession_lineage: existing?.id ? [existing.id] : []
          })
        ]
      );
    }

    for (const existing of existingSummaryRows.rows) {
      if (activeKeys.has(existing.canonical_key)) {
        continue;
      }

      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = now(),
            status = 'superseded'
          WHERE id = $1
        `,
        [existing.id]
      );
      retired += 1;

      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            reason,
            metadata
          )
          VALUES ($1, $2, 'weak', 'supersede', 'state_summary', $3::uuid, $4, $5::jsonb)
        `,
        [
          namespaceId,
          `retire stale mutable state summary ${existing.canonical_key}`,
          existing.id,
          `Retired mutable state summary ${existing.canonical_key} because no active procedural state remains.`,
          JSON.stringify({
            run_id: runId,
            canonical_key: existing.canonical_key,
            retired_without_active_state: true
          })
        ]
      );
    }

    for (const existing of existingProfileRows.rows) {
      if (activeProfileKeys.has(existing.canonical_key)) {
        continue;
      }

      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = now(),
            status = 'superseded'
          WHERE id = $1
        `,
        [existing.id]
      );
      retired += 1;

      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            reason,
            metadata
          )
          VALUES ($1, $2, 'weak', 'supersede', 'profile_summary', $3::uuid, $4, $5::jsonb)
        `,
        [
          namespaceId,
          `retire stale profile summary ${existing.canonical_key}`,
          existing.id,
          `Retired profile summary ${existing.canonical_key} because the active state pattern no longer supports it.`,
          JSON.stringify({
            run_id: runId,
            canonical_key: existing.canonical_key,
            adjudication_action: "supersede",
            reconsolidation_decision: "supersede",
            retired_without_active_state: true
          })
        ]
      );
    }

    return {
      runId,
      namespaceId,
      added,
      superseded,
      retired,
      abstained,
      processedKeys
    };
  });
}

export async function runMemoryReconsolidation(
  input: RunMemoryReconsolidationInput
): Promise<MemoryReconsolidationSummary> {
  const profilePerson = parseRelationshipProfileConsistencyQuery(input.query);
  if (profilePerson) {
    return runRelationshipProfileReconsolidation(input, profilePerson);
  }

  const beliefTopic = parseBeliefProfileConsistencyQuery(input.query);
  if (beliefTopic) {
    return runBeliefProfileReconsolidation(input, beliefTopic);
  }

  const runId = randomUUID();
  const response = await searchMemory({
    namespaceId: input.namespaceId,
    query: input.query,
    timeStart: input.timeStart,
    timeEnd: input.timeEnd,
    limit: input.limit ?? 8
  });

  const priorConfidence = response.meta.answerAssessment?.confidence ?? "missing";
  const inferredTimeStart = response.meta.planner.inferredTimeStart ?? input.timeStart;
  const inferredTimeEnd = response.meta.planner.inferredTimeEnd ?? input.timeEnd;
  const summaryNeedsReconsolidation =
    priorConfidence === "confident" &&
    response.meta.planner.queryClass === "temporal_summary" &&
    response.meta.planner.leafEvidenceRequired === false &&
    response.meta.answerAssessment?.directEvidence === false;

  if (
    (!isWeakOrMissing(priorConfidence) && !summaryNeedsReconsolidation) ||
    !hasAdequateEvidence(response.results, response.evidence.length, inferredTimeStart, inferredTimeEnd)
  ) {
    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            reason,
            metadata
          )
          VALUES ($1, $2, $3, 'skip', 'day_summary', $4, $5::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          priorConfidence,
          summaryNeedsReconsolidation
            ? "Reconsolidation did not trigger because adequate day-summary evidence was missing."
            : "Reconsolidation did not trigger because the query was already confident or lacked adequate day-summary evidence.",
          JSON.stringify({
            run_id: runId,
            summary_needs_reconsolidation: summaryNeedsReconsolidation
          })
        ]
      );
    });

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action: "skip",
      reason: "Reconsolidation did not trigger."
    };
  }

  const top = response.results[0];
  if (!top || !inferredTimeStart || !inferredTimeEnd) {
    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action: "abstain",
      reason: "Reconsolidation could not resolve a day window from the weak answer."
    };
  }

  const canonicalKey = buildDaySummaryCanonicalKey(inferredTimeStart);
  const formattedDay = formatUtcDayLabel(inferredTimeStart);
  const topEventsRaw =
    typeof top.provenance?.metadata === "object" && top.provenance.metadata
      ? String((top.provenance.metadata as Record<string, unknown>).top_events ?? "")
      : "";
  const topEvents = topEventsRaw
    .split(/\s*,\s*/u)
    .map((item) => item.replace(/:\d+$/u, "").trim())
    .filter(Boolean);
  const humanSummary = topEvents.length > 0
    ? `Steve's day on ${formattedDay} included ${formatList(topEvents)}.`
    : `Steve's day on ${formattedDay} included ${top.content.replace(/^DAY rollup\s+/u, "").trim()}`;
  const daySummaryContent = normalizeSummaryContent(humanSummary);
  const sourceArtifactId = response.evidence.find((item) => item.artifactId)?.artifactId ?? top.artifactId ?? null;
  const sourceEpisodicId = await resolveSourceEpisodicId(input.namespaceId, sourceArtifactId, inferredTimeStart, inferredTimeEnd);

  return withTransaction(async (client) => {
    const existingResult = await client.query<{
      id: string;
      content_abstract: string;
    }>(
      `
        SELECT id, content_abstract
        FROM semantic_memory
        WHERE namespace_id = $1
          AND canonical_key = $2
          AND status = 'active'
          AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 1
      `,
      [input.namespaceId, canonicalKey]
    );

    const existing = existingResult.rows[0];
    if (existing && normalizeSummaryContent(existing.content_abstract) === daySummaryContent) {
      await client.query(
        `
          INSERT INTO memory_reconsolidation_events (
            namespace_id,
            query_text,
            trigger_confidence,
            action,
            target_memory_kind,
            semantic_memory_id,
            source_episodic_id,
            reason,
            metadata
          )
          VALUES ($1, $2, $3, 'abstain', 'day_summary', $4::uuid, $5::uuid, $6, $7::jsonb)
        `,
        [
          input.namespaceId,
          input.query,
          priorConfidence,
          existing.id,
          sourceEpisodicId,
          "An evidence-anchored day summary already existed with matching content.",
          JSON.stringify({
            run_id: runId,
            canonical_key: canonicalKey,
            inferred_time_start: inferredTimeStart,
            inferred_time_end: inferredTimeEnd
          })
        ]
      );

      return {
        runId,
        namespaceId: input.namespaceId,
        query: input.query,
        priorConfidence,
        action: "abstain",
        semanticMemoryId: existing.id,
        reason: "Matching day summary already existed."
      };
    }

    const insertResult = await client.query<{ id: string }>(
      `
        INSERT INTO semantic_memory (
          namespace_id,
          content_abstract,
          importance_score,
          valid_from,
          valid_until,
          status,
          is_anchor,
          source_episodic_id,
          memory_kind,
          canonical_key,
          normalized_value,
          metadata,
          decay_exempt
        )
        VALUES ($1, $2, 0.87, $3::timestamptz, NULL, 'active', true, $4::uuid, 'day_summary', $5, $6::jsonb, $7::jsonb, true)
        RETURNING id
      `,
      [
        input.namespaceId,
        daySummaryContent,
        inferredTimeStart,
        sourceEpisodicId,
        canonicalKey,
        JSON.stringify({
          query: input.query,
          day_start: inferredTimeStart,
          day_end: inferredTimeEnd
        }),
        JSON.stringify({
          source: "memory_reconsolidation",
          run_id: runId,
          trigger_confidence: priorConfidence,
          evidence_count: response.evidence.length,
          derived_from_memory_id: top.memoryId,
          derived_from_memory_type: top.memoryType,
          source_artifact_id: sourceArtifactId
        })
      ]
    );

    const semanticMemoryId = insertResult.rows[0]?.id;
    if (!semanticMemoryId) {
      throw new Error("Failed to create reconsolidated semantic day summary.");
    }

    let action: MemoryReconsolidationSummary["action"] = "add";
    let reason = "Added an evidence-anchored day summary semantic note after a weak day query.";

    if (existing) {
      await client.query(
        `
          UPDATE semantic_memory
          SET
            valid_until = $2::timestamptz,
            status = 'superseded',
            superseded_by_id = $3::uuid
          WHERE id = $1
        `,
        [existing.id, inferredTimeStart, semanticMemoryId]
      );
      action = "supersede";
      reason = "Superseded an older reconsolidated day summary with stronger evidence-backed content.";
    }

    await client.query(
      `
        INSERT INTO memory_reconsolidation_events (
          namespace_id,
          query_text,
          trigger_confidence,
          action,
          target_memory_kind,
          semantic_memory_id,
          source_episodic_id,
          reason,
          metadata
        )
        VALUES ($1, $2, $3, $4, 'day_summary', $5::uuid, $6::uuid, $7, $8::jsonb)
      `,
      [
        input.namespaceId,
        input.query,
        priorConfidence,
        action,
        semanticMemoryId,
        sourceEpisodicId,
        reason,
        JSON.stringify({
          run_id: runId,
          canonical_key: canonicalKey,
          inferred_time_start: inferredTimeStart,
          inferred_time_end: inferredTimeEnd,
          evidence_count: response.evidence.length
        })
      ]
    );

    return {
      runId,
      namespaceId: input.namespaceId,
      query: input.query,
      priorConfidence,
      action,
      semanticMemoryId,
      reason
    };
  });
}
