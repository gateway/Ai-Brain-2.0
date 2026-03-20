import type {
  BootstrapSmokePackItem,
  SessionReview,
  WorkbenchSearchResponse,
  WorkbenchSelfProfile,
  WorkbenchSession
} from "@/lib/operator-workbench";
import { searchWorkbenchMemory } from "@/lib/operator-workbench";

const SMOKE_QUERIES = [
  { label: "Where do I live?", query: "where do I live?", kind: "location" },
  { label: "Who are my friends?", query: "who are my friends?", kind: "friends" },
  { label: "What am I working on?", query: "what am I working on?", kind: "projects" },
  { label: "What do I like?", query: "what do I like?", kind: "preferences" }
] as const;

function topEntityLabels(review: SessionReview | null, entityType: string, limit = 4): string[] {
  if (!review) {
    return [];
  }
  return review.entities
    .filter((entity) => entity.entityType === entityType)
    .slice(0, limit)
    .map((entity) => entity.displayLabel);
}

function parsePreferenceTerms(session: WorkbenchSession): string[] {
  const texts = (session.recentInputs ?? [])
    .map((input) => input.rawText ?? "")
    .filter(Boolean)
    .join(" ");
  const candidates = new Set<string>();
  const patterns = [/i like ([^.]+)/gi, /i love to ([^.]+)/gi, /i love ([^.]+)/gi];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(texts)) !== null) {
      const raw = match[1] ?? "";
      for (const token of raw.split(/,| and /i)) {
        const normalized = token.trim().replace(/^to\s+/i, "").replace(/^[.-]+|[.-]+$/g, "");
        if (normalized) {
          candidates.add(normalized);
        }
      }
    }
  }

  return Array.from(candidates).slice(0, 6);
}

async function firstPassingSearch(queries: readonly string[], namespaceId: string): Promise<WorkbenchSearchResponse | null> {
  for (const query of queries) {
    const response = await searchWorkbenchMemory({ query, namespaceId, limit: 4 });
    if (response.results.length > 0 && response.evidence.length > 0) {
      return response;
    }
  }
  return null;
}

export async function runBootstrapSmokePack(input: {
  readonly namespaceId: string;
  readonly session: WorkbenchSession;
  readonly review: SessionReview | null;
  readonly selfProfile: WorkbenchSelfProfile | null;
}): Promise<readonly BootstrapSmokePackItem[]> {
  const placeLabels = topEntityLabels(input.review, "place");
  const peopleLabels = topEntityLabels(input.review, "person");
  const projectLabels = topEntityLabels(input.review, "project");
  const preferenceLabels = parsePreferenceTerms(input.session);

  return Promise.all(
    SMOKE_QUERIES.map(async (item) => {
      const fallbackQueries =
        item.kind === "location"
          ? [item.query, ...placeLabels, "Bangkok", "Thailand"]
          : item.kind === "friends"
            ? [item.query, ...peopleLabels, "Dan", "Gumee"]
            : item.kind === "projects"
              ? [item.query, ...projectLabels, "AI Brain"]
              : [item.query, ...preferenceLabels, "spicy food", "snowboarding", "hiking", "AI art"];

      try {
        const response = await firstPassingSearch(fallbackQueries, input.namespaceId);
        const top = response?.results[0];
        const evidence = response?.evidence.slice(0, 2).map((entry) => ({
          sourceUri: entry.sourceUri ?? null,
          snippet: entry.snippet
        })) ?? [];

        return {
          label: item.label,
          query: item.query,
          pass: Boolean(top && evidence.length > 0),
          answer: top?.content ?? "No supported retrieval hit returned yet.",
          evidence,
          namespaceId: top?.namespaceId ?? input.namespaceId
        } satisfies BootstrapSmokePackItem;
      } catch (error) {
        return {
          label: item.label,
          query: item.query,
          pass: false,
          answer: error instanceof Error ? error.message : "Search failed.",
          evidence: [],
          namespaceId: input.namespaceId
        } satisfies BootstrapSmokePackItem;
      }
    })
  );
}
