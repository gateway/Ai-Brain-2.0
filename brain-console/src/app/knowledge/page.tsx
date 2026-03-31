import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getBootstrapState,
  getWorkbenchClarifications,
  getWorkbenchSelfProfile,
  searchWorkbenchMemory,
  type WorkbenchSearchResponse
} from "@/lib/operator-workbench";
import { requireSetupComplete } from "@/lib/setup-gating";

function formatAnswer(response: WorkbenchSearchResponse, fallback: string): string {
  const claimText = response.duality?.claim?.text?.trim();
  if (claimText) {
    return claimText;
  }
  const top = response.results[0];
  if (!top?.content) {
    return fallback;
  }
  return top.content;
}

function compactEvidence(response: WorkbenchSearchResponse): readonly { readonly sourceUri?: string | null; readonly snippet: string }[] {
  return response.evidence.slice(0, 2).map((item) => ({
    sourceUri: item.sourceUri,
    snippet: item.snippet
  }));
}

function metaString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

function nestedMetaString(meta: Record<string, unknown>, parent: string, key: string): string | undefined {
  const value = meta[parent];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function shortSourceLabel(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || trimmed;
}

async function loadQueryCard(namespaceId: string, query: string, fallback: string) {
  const response = await searchWorkbenchMemory({
    namespaceId,
    query,
    limit: 4
  }).catch(() => null);

  if (!response) {
    return {
      query,
      answer: fallback,
      evidence: [] as const,
      retrievalMode: "unavailable",
      fallbackReason: "search failed",
      rankingKernel: undefined,
      synthesisMode: undefined,
      queryModeHint: undefined,
      followUpAction: undefined,
      adequacyStatus: undefined,
      topMemoryType: undefined,
      clarificationPrompt: undefined
    };
  }

  return {
    query,
    answer: formatAnswer(response, fallback),
    evidence: compactEvidence(response),
    retrievalMode: typeof response.meta.retrievalMode === "string" ? response.meta.retrievalMode : "unknown",
    fallbackReason: typeof response.meta.fallbackReason === "string" ? response.meta.fallbackReason : undefined,
    rankingKernel: metaString(response.meta, "rankingKernel"),
    synthesisMode: metaString(response.meta, "synthesisMode"),
    queryModeHint: metaString(response.meta, "queryModeHint"),
    followUpAction: metaString(response.meta, "followUpAction"),
    adequacyStatus: metaString(response.meta, "adequacyStatus"),
    topMemoryType: response.results[0]?.memoryType,
    clarificationPrompt: nestedMetaString(response.meta, "clarificationHint", "suggestedPrompt")
  };
}

async function loadKnowledgeCard(
  namespaceId: string,
  input: {
    readonly query: string;
    readonly fallback: string;
    readonly historyQuery?: string;
    readonly historyFallback?: string;
  }
) {
  const [current, historical] = await Promise.all([
    loadQueryCard(namespaceId, input.query, input.fallback),
    input.historyQuery
      ? loadQueryCard(namespaceId, input.historyQuery, input.historyFallback ?? "No superseded value has been surfaced yet.")
      : Promise.resolve(null)
  ]);

  return {
    ...current,
    historyQuery: input.historyQuery,
    historical
  };
}

export default async function KnowledgePage() {
  await requireSetupComplete("/knowledge");

  const bootstrap = await getBootstrapState();
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";

  const [selfProfile, clarifications, warmStart, home, projects, people, routines, beliefs, preferences, purchases, mediaMentions, routineSnapshot, habitsAndConstraints, relationshipTransition] = await Promise.all([
    getWorkbenchSelfProfile(namespaceId).catch(() => null),
    getWorkbenchClarifications(namespaceId, 10).catch(() => null),
    loadQueryCard(namespaceId, "What should you know about me to start today?", "No grounded warm-start pack has been assembled yet."),
    loadKnowledgeCard(namespaceId, {
      query: "where do I live?",
      fallback: "The brain has not verified your current home yet.",
      historyQuery: "where did I live before now?",
      historyFallback: "No older home signal has been grounded yet."
    }),
    loadKnowledgeCard(namespaceId, {
      query: "what am I working on?",
      fallback: "No active project answer yet.",
      historyQuery: "what projects was I working on before this?",
      historyFallback: "No older project state surfaced yet."
    }),
    loadKnowledgeCard(namespaceId, {
      query: "who are my friends?",
      fallback: "Important people are not grounded clearly yet.",
      historyQuery: "who used to be close to me or no longer shows up?",
      historyFallback: "No older people shift surfaced yet."
    }),
    loadKnowledgeCard(namespaceId, {
      query: "what routines do I have?",
      fallback: "No stable routine answer yet.",
      historyQuery: "what routines changed over time?",
      historyFallback: "No routine change signal surfaced yet."
    }),
    loadKnowledgeCard(namespaceId, {
      query: "what is my current stance on infrastructure?",
      fallback: "No active belief summary yet.",
      historyQuery: "what was my previous stance on infrastructure?",
      historyFallback: "No older infrastructure stance surfaced yet."
    }),
    loadKnowledgeCard(namespaceId, {
      query: "what do I like and dislike?",
      fallback: "No grounded explicit preference facts yet.",
      historyQuery: "what preferences changed over time?",
      historyFallback: "No superseded preference surfaced yet."
    }),
    loadQueryCard(namespaceId, "what did I buy today and what were the prices?", "No purchase fact has been grounded yet."),
    loadQueryCard(namespaceId, "what movies have I talked about?", "No media facts have been grounded yet."),
    loadQueryCard(namespaceId, "what is my current daily routine?", "No grounded routine snapshot has been assembled yet."),
    loadQueryCard(namespaceId, "what habits or constraints matter right now?", "No grounded habits or constraints have been assembled yet."),
    loadQueryCard(namespaceId, "what important relationship transition should I know about right now?", "No grounded relationship transition has been assembled yet.")
  ]);

  const typedFactCards = [
    {
      title: "Purchases",
      description: "Typed fact lane for bought items and honest total-only price reporting",
      ...purchases
    },
    {
      title: "Media mentions",
      description: "Movies, shows, and related titles grounded through typed media mention extraction",
      ...mediaMentions
    },
    {
      title: "Preferences",
      description: "Explicit likes/dislikes only. If the corpus does not ground a preference, this surface should abstain.",
      ...preferences
    },
    {
      title: "Routine snapshot",
      description: "Compact daily-routine summary pulled from explicit recent routine evidence, not generic transcript echo.",
      ...routineSnapshot
    },
    {
      title: "Habits and constraints",
      description: "Grounded routines, habits, and active constraints that currently matter operationally.",
      ...habitsAndConstraints
    },
    {
      title: "Relationship transition",
      description: "The strongest relationship change signal that currently matters for startup context.",
      ...relationshipTransition
    }
  ];

  const primaryCards = [
    {
      title: "Warm start",
      description: "What the brain should carry into today before you ask for anything else",
      ...warmStart,
      historyQuery: undefined,
      historical: null
    },
    {
      title: "Self identity",
      description: "Who this brain belongs to",
      answer: selfProfile ? `${selfProfile.canonicalName}${selfProfile.aliases.length ? ` · aliases: ${selfProfile.aliases.join(", ")}` : ""}` : "No self profile has been saved yet.",
      evidence: [] as const,
      retrievalMode: "profile",
      query: "who am i?",
      historyQuery: undefined,
      historical: null
    },
    { title: "Current location", description: "Where the brain believes you live", ...home },
    { title: "Current projects", description: "What the brain thinks is active right now", ...projects },
    { title: "Important people", description: "Who keeps showing up in your canonical atlas", ...people }
  ];

  return (
    <OperatorShell
      currentPath="/knowledge"
      title="What It Knows"
      subtitle="See what the brain currently believes, what supports it, and what still needs grounding."
    >
      <div className="space-y-6">
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_28%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Knowledge surface</CardDescription>
              <CardTitle>Start here when you want the answer, not the plumbing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>
                If something here looks wrong, go to{" "}
                <Link href="/clarifications" className="font-medium text-cyan-100 hover:text-white">
                  Clarifications
                </Link>{" "}
                or{" "}
                <Link href="/sources" className="font-medium text-cyan-100 hover:text-white">
                  Sources
                </Link>
                , not vague optimism.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge variant="outline" className="border-emerald-300/20 bg-emerald-300/10 text-emerald-50">
                  Continuity-first startup live
                </Badge>
                <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-50">
                  Personal recall green
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  Clarification queue live
                </Badge>
                <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                  Typed purchases, preferences, and media live
                </Badge>
                <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-50">
                  Warm-start pack live
                </Badge>
                <Badge variant="outline" className="border-cyan-300/20 bg-cyan-300/10 text-cyan-50">
                  Temporal relationship routing live
                </Badge>
              </div>
              <p>
                The current backend is aligned to recap-first startup, canonical entities, compact private recall, typed purchase/media/preference lanes,
                warm-start startup context, routine shaping from explicit recent notes, stable preference carry-forward, direct temporal relationship routing,
                and explicit abstention when the corpus does not ground a preference. Session-scoped graph work is still a derived bridge, so use
                the relationships console when you need the current atlas. For exact relationship lookups, prefer the query surface; for ambiguous
                names, aliases, and places, use Clarifications before assuming the graph is right.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <Card size="sm" className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.88)_0%,_rgba(8,11,20,0.92)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Self anchor</CardDescription>
                <CardTitle className="text-lg text-white">{selfProfile?.canonicalName ?? "missing"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{selfProfile ? `${selfProfile.aliases.length} aliases saved.` : "No explicit self profile bound yet."}</CardContent>
            </Card>
            <Card size="sm" className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.88)_0%,_rgba(8,11,20,0.92)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Clarifications</CardDescription>
                <CardTitle className="text-lg text-white">{clarifications?.summary.total ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">
                {clarifications?.summary.byPriority.priority_1 ?? 0} priority 1 unknowns are still blocking clean grounding and entity attachment.
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {primaryCards.map((item) => (
            <Card key={item.title} className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader>
                <CardDescription>{item.description}</CardDescription>
                <CardTitle>{item.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-[20px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-200">
                  {item.answer}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                    retrieval {item.retrievalMode}
                  </Badge>
                  {"fallbackReason" in item && item.fallbackReason ? (
                    <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                      {item.fallbackReason}
                    </Badge>
                  ) : null}
                </div>
                {item.evidence.length ? (
                  <div className="space-y-2">
                    {item.evidence.map((evidence) => (
                      <div key={`${item.title}:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[18px] border border-white/8 bg-black/15 p-3 text-xs leading-6 text-slate-300">
                        <p>{evidence.snippet}</p>
                        {shortSourceLabel(evidence.sourceUri) ? <p className="mt-1 text-slate-400">{shortSourceLabel(evidence.sourceUri)}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <details className="rounded-[18px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                  <summary className="cursor-pointer list-none font-medium text-white">Why this is believed</summary>
                  <div className="mt-3 space-y-3">
                    <p>
                      This answer comes from the current retrieval pass for{" "}
                      <span className="font-medium text-white">{item.query ?? "the active knowledge card"}</span> using the evidence shown
                      above. If retrieval falls back or looks thin, treat the answer as a cue to inspect source material or clarify the entity, not divine truth.
                    </p>
                    {item.query ? (
                      <Link href={`/console/query?query=${encodeURIComponent(item.query)}`} className="text-cyan-100 hover:text-white">
                        Open this question in Query
                      </Link>
                    ) : null}
                  </div>
                </details>
                <details className="rounded-[18px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                  <summary className="cursor-pointer list-none font-medium text-white">What superseded the old value</summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-slate-200">{item.historical?.answer ?? "No older signal surfaced yet."}</p>
                    {item.historical?.evidence.length ? (
                      <div className="space-y-2">
                        {item.historical.evidence.map((evidence) => (
                          <div key={`${item.title}:history:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[16px] border border-white/8 bg-white/5 p-3 text-xs leading-6 text-slate-300">
                            <p>{evidence.snippet}</p>
                            {shortSourceLabel(evidence.sourceUri) ? <p className="mt-1 text-slate-500">{shortSourceLabel(evidence.sourceUri)}</p> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {item.historyQuery ? (
                      <Link href={`/console/query?query=${encodeURIComponent(item.historyQuery)}`} className="text-cyan-100 hover:text-white">
                        Open the older-state query
                      </Link>
                    ) : null}
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Typed fact watch</CardDescription>
            <CardTitle>Purchases, media, and preference-style facts</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 xl:grid-cols-3">
            {typedFactCards.map((item) => (
              <div key={item.title} className="rounded-[22px] border border-white/8 bg-white/5 p-4">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-white">{item.title}</p>
                  <p className="text-xs leading-6 text-slate-400">{item.description}</p>
                </div>
                <div className="mt-4 rounded-[18px] border border-white/8 bg-black/15 p-3 text-sm leading-7 text-slate-200">
                  {item.answer}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                    retrieval {item.retrievalMode}
                  </Badge>
                  {item.rankingKernel ? (
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                      kernel {item.rankingKernel}
                    </Badge>
                  ) : null}
                  {item.queryModeHint ? (
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                      {item.queryModeHint}
                    </Badge>
                  ) : null}
                  {item.topMemoryType ? (
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-200">
                      top {item.topMemoryType}
                    </Badge>
                  ) : null}
                  {item.followUpAction === "route_to_clarifications" ? (
                    <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                      needs clarification
                    </Badge>
                  ) : null}
                </div>
                {item.evidence.length ? (
                  <div className="mt-3 space-y-2">
                    {item.evidence.map((evidence) => (
                      <div key={`${item.title}:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[16px] border border-white/8 bg-black/15 p-3 text-xs leading-6 text-slate-300">
                        <p>{evidence.snippet}</p>
                        {shortSourceLabel(evidence.sourceUri) ? <p className="mt-1 text-slate-500">{shortSourceLabel(evidence.sourceUri)}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
                  {item.adequacyStatus ? <p>Adequacy: <span className="text-slate-100">{item.adequacyStatus}</span></p> : null}
                  {item.synthesisMode ? <p>Synthesis: <span className="text-slate-100">{item.synthesisMode}</span></p> : null}
                  {item.clarificationPrompt ? (
                    <p className="rounded-[16px] border border-amber-300/15 bg-amber-300/8 p-3">{item.clarificationPrompt}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-3">
                    <Link href={`/console/query?query=${encodeURIComponent(item.query)}`} className="text-cyan-100 hover:text-white">
                      Open in Query
                    </Link>
                    {item.followUpAction === "route_to_clarifications" ? (
                      <Link href="/clarifications" className="text-amber-100 hover:text-white">
                        Open Clarifications
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <details className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)] p-5">
          <summary className="cursor-pointer list-none text-lg font-semibold tracking-tight text-white">More lenses: routines, beliefs, and preferences</summary>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            Open this when you want the deeper personality and behavior layer. Most operators should not need to read every card here on every visit.
          </p>
          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            {[
              { title: "Routines", description: "Stable patterns the brain thinks you repeat", ...routines },
              { title: "Current beliefs", description: "Active stance, not old debate residue", ...beliefs },
              { title: "Preferences", description: "Tastes and likes that have enough evidence to matter", ...preferences }
            ].map((item) => (
              <Card key={item.title} className="border-white/8 bg-white/5">
                <CardHeader>
                  <CardDescription>{item.description}</CardDescription>
                  <CardTitle>{item.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-[18px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-200">{item.answer}</div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      retrieval {item.retrievalMode}
                    </Badge>
                    {"fallbackReason" in item && item.fallbackReason ? (
                      <Badge variant="outline" className="border-amber-300/20 bg-amber-300/10 text-amber-100">
                        {item.fallbackReason}
                      </Badge>
                    ) : null}
                  </div>
                  {item.evidence.length ? (
                    <div className="space-y-2">
                      {item.evidence.map((evidence) => (
                        <div key={`${item.title}:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[16px] border border-white/8 bg-white/5 p-3 text-xs leading-6 text-slate-300">
                          <p>{evidence.snippet}</p>
                          {shortSourceLabel(evidence.sourceUri) ? <p className="mt-1 text-slate-500">{shortSourceLabel(evidence.sourceUri)}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <Link href={`/console/query?query=${encodeURIComponent(item.query)}`} className="text-cyan-100 hover:text-white">
                    Open this question in Query
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </details>
      </div>
    </OperatorShell>
  );
}
