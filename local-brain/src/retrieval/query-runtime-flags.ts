import { queryCatalogEntryForContract } from "./query-catalog-v1.js";

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function supportedByDefault(contractName: Parameters<typeof queryCatalogEntryForContract>[0]): boolean {
  return queryCatalogEntryForContract(contractName)?.supportedByDefault === true;
}

export function relationshipProjectionEnabled(): boolean {
  return parseBooleanFlag(
    process.env.BRAIN_ENABLE_RELATIONSHIP_MAP_PROJECTION,
    supportedByDefault("relationship_chronology") || supportedByDefault("relationship_map")
  );
}

export function sharedSocialGraphEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_SHARED_SOCIAL_GRAPH, supportedByDefault("shared_social_graph"));
}

export function aliasCurrentStateProjectionEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_ALIAS_CURRENT_STATE_PROJECTION, supportedByDefault("current_state"));
}

export function continuityCurrentStateProjectionEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_CONTINUITY_CURRENT_STATE_PROJECTION, supportedByDefault("current_state"));
}

export function recapProfileProjectionEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_RECAP_PROFILE_PROJECTION, supportedByDefault("profile_report"));
}

export function profileReportProjectionEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_PROFILE_REPORT_PROJECTION, supportedByDefault("profile_report"));
}

export function projectDefinitionProjectionEnabled(): boolean {
  return parseBooleanFlag(process.env.BRAIN_ENABLE_PROJECT_DEFINITION_PROJECTION, supportedByDefault("project_definition"));
}

export function anyDefaultProjectionBackedQueryEnabled(): boolean {
  return (
    relationshipProjectionEnabled() ||
    aliasCurrentStateProjectionEnabled() ||
    continuityCurrentStateProjectionEnabled() ||
    recapProfileProjectionEnabled() ||
    profileReportProjectionEnabled() ||
    projectDefinitionProjectionEnabled()
  );
}
