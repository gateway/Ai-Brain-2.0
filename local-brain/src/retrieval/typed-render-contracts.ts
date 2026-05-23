import {
  isConcreteMusicArtistHistoryQuery,
  isConcretePaintedItemQuery,
  isConcretePetNameQuery,
  isConcretePotteryItemQuery,
  isConcreteSymbolInventoryQuery
} from "./query-signals.js";
import { isCampingLocationQuery } from "./location-history/camping.js";
import type {
  ListSetSupport,
  RenderedSupportClaim
} from "./support-objects.js";

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function joinCanonicalItems(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0]!;
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatQuotedList(items: readonly string[]): string {
  return items.map((item) => `"${item}"`).join(", ");
}

function selectPreferredSupportNetworkEntry(values: readonly string[]): string | null {
  const normalizedValues = values.map((value) => normalize(value)).filter(Boolean);
  if (normalizedValues.length === 0) {
    return null;
  }
  const rankingRules: ReadonlyArray<readonly [RegExp, number]> = [
    [/\bteammates?\b|\bteam\b/iu, 5],
    [/\bold friends?\b/iu, 4],
    [/\bgaming conventions?\b/iu, 3],
    [/\busual circle\b/iu, 2]
  ];
  const ranked = [...normalizedValues].sort((left, right) => {
    const leftScore = rankingRules.find(([pattern]) => pattern.test(left))?.[1] ?? 0;
    const rightScore = rankingRules.find(([pattern]) => pattern.test(right))?.[1] ?? 0;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.localeCompare(right);
  });
  return ranked[0] ?? null;
}

function orderSupportNetworkEntries(values: readonly string[]): readonly string[] {
  const normalizedValues = values.map((value) => normalize(value)).filter(Boolean);
  const priority = (value: string): number => {
    if (/\bmentors?\b/iu.test(value)) return 4;
    if (/\bfamily\b/iu.test(value)) return 3;
    if (/\bfriends?\b/iu.test(value)) return 2;
    return 1;
  };
  return [...normalizedValues].sort((left, right) => priority(right) - priority(left) || left.localeCompare(right));
}

export function resolveListSetRenderContract(queryText: string, support: ListSetSupport): string {
  if (support.typedEntries.length === 0) {
    return "mixed_set_join";
  }
  if (support.typedEntryType === "book_title") {
    return "book_list_render";
  }
  if (support.typedEntryType === "activity_name") {
    return "activity_list_render";
  }
  if (support.typedEntryType === "event_name") {
    return "event_list_render";
  }
  if (support.typedEntryType === "support_contact") {
    return "support_network_render";
  }
  if (support.typedEntryType === "location_place" || support.typedEntryType === "country" || support.typedEntryType === "venue") {
    return isCampingLocationQuery(queryText) ? "camping_location_list_render" : "location_list_render";
  }
  if (isConcretePaintedItemQuery(queryText)) {
    return "painted_item_list_render";
  }
  if (isConcretePotteryItemQuery(queryText)) {
    return "pottery_item_list_render";
  }
  if (
    isConcreteMusicArtistHistoryQuery(queryText) ||
    isConcretePetNameQuery(queryText) ||
    isConcreteSymbolInventoryQuery(queryText)
  ) {
    return "inventory_list_render";
  }
  return "typed_set_join";
}

export function renderListSetContract(params: {
  readonly queryText: string;
  readonly support: ListSetSupport;
  readonly supportRowsSelected: number;
}): RenderedSupportClaim {
  const { queryText, support, supportRowsSelected } = params;
  const baseValues = support.typedEntries.length > 0 ? support.typedEntries : support.fallbackEntries;
  const renderContractSelected = resolveListSetRenderContract(queryText, support);
  const values =
    renderContractSelected === "support_network_render"
      ? orderSupportNetworkEntries(baseValues)
      : baseValues;
  const joined =
    renderContractSelected === "book_list_render"
      ? formatQuotedList(values)
      : renderContractSelected === "support_network_render" && support.binarySupportInference
        ? (() => {
            const preferredValue = selectPreferredSupportNetworkEntry(values);
            return preferredValue ? `Yes, ${preferredValue}.` : `Yes, ${joinCanonicalItems(values)}.`;
          })()
      : support.predicateFamily === "commonality"
        ? support.subjectPlan.kind === "pair_subject"
          ? `They ${joinCanonicalItems(values)}.`
          : joinCanonicalItems(values)
        : joinCanonicalItems(values);
  return {
    claimText: joined || null,
    shapingMode: support.typedEntries.length > 0 ? "typed_set_entries" : "mixed_string_set",
    typedValueUsed: support.typedEntries.length > 0,
    generatedProseUsed: support.predicateFamily === "commonality" && support.subjectPlan.kind === "pair_subject",
    runtimeResynthesisUsed: false,
    supportRowsSelected,
    supportTextsSelected: 0,
    supportSelectionMode: null,
    targetedRetrievalAttempted: support.targetedRetrievalAttempted,
    targetedRetrievalReason: support.targetedRetrievalReason,
    targetedFieldsRequested: support.targetedFieldsRequested,
    targetedRetrievalSatisfied: support.targetedRetrievalSatisfied,
    typedSetEntryCount: support.typedEntries.length,
    typedSetEntryType: support.typedEntryType,
    supportObjectsBuilt: 1,
    supportObjectType: support.supportObjectType,
    supportNormalizationFailures: support.supportNormalizationFailures,
    renderContractSelected,
    renderContractFallbackReason: support.typedEntries.length > 0 ? null : "typed_entries_missing"
  };
}
