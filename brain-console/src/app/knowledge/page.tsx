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

async function loadQueryCard(namespaceId: string, query: string, fallback: string) {
  const response = await searchWorkbenchMemory({
    namespaceId,
    query,
    limit: 4
  }).catch(() => null);

  if (!response) {
    return {
      answer: fallback,
      evidence: [] as const,
      retrievalMode: "unavailable",
      fallbackReason: "search failed"
    };
  }

  return {
    query,
    answer: formatAnswer(response, fallback),
    evidence: compactEvidence(response),
    retrievalMode: typeof response.meta.retrievalMode === "string" ? response.meta.retrievalMode : "unknown",
    fallbackReason: typeof response.meta.fallbackReason === "string" ? response.meta.fallbackReason : undefined
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

  const [selfProfile, clarifications, home, projects, people, routines, beliefs, preferences] = await Promise.all([
    getWorkbenchSelfProfile(namespaceId).catch(() => null),
    getWorkbenchClarifications(namespaceId, 10).catch(() => null),
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
      query: "what do I like?",
      fallback: "Preferences are still too foggy.",
      historyQuery: "what preferences changed over time?",
      historyFallback: "No superseded preference surfaced yet."
    })
  ]);

  const topClarifications = clarifications?.items.slice(0, 5) ?? [];

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
              <p>If something here looks wrong, go to <Link href="/clarifications" className="font-medium text-cyan-100 hover:text-white">Clarifications</Link> or <Link href="/sources" className="font-medium text-cyan-100 hover:text-white">Sources</Link>, not vague optimism.</p>
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
              <CardContent className="text-sm text-slate-300">{clarifications?.summary.byPriority.priority_1 ?? 0} priority 1 unknowns are still blocking clean grounding.</CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {[
            { title: "Self identity", description: "Who this brain belongs to", answer: selfProfile ? `${selfProfile.canonicalName}${selfProfile.aliases.length ? ` · aliases: ${selfProfile.aliases.join(", ")}` : ""}` : "No self profile has been saved yet.", evidence: [] as const, retrievalMode: "profile", query: "who am i?", historyQuery: undefined, historical: null },
            { title: "Current location", description: "Where the brain believes you live", ...home },
            { title: "Current projects", description: "What the brain thinks is active right now", ...projects },
            { title: "Important people", description: "Who keeps showing up in your graph", ...people }
          ].map((item) => (
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
                        {evidence.sourceUri ? <p className="mt-1 text-slate-400">{evidence.sourceUri}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <details className="rounded-[18px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                  <summary className="cursor-pointer list-none font-medium text-white">Why this is believed</summary>
                  <div className="mt-3 space-y-3">
                    <p>This answer comes from the current retrieval pass for <span className="font-medium text-white">{item.query ?? "the active knowledge card"}</span> using the evidence shown above. If retrieval falls back or looks thin, treat the answer as a cue to inspect source material, not divine truth.</p>
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
                            {evidence.sourceUri ? <p className="mt-1 text-slate-500">{evidence.sourceUri}</p> : null}
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
              <Card key={item.title} className="border-white/8 bg-black/15">
                <CardHeader>
                  <CardDescription>{item.description}</CardDescription>
                  <CardTitle>{item.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-[18px] border border-white/8 bg-white/5 p-4 text-sm leading-7 text-slate-200">
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
                        <div key={`${item.title}:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[16px] border border-white/8 bg-black/15 p-3 text-xs leading-6 text-slate-300">
                          <p>{evidence.snippet}</p>
                          {evidence.sourceUri ? <p className="mt-1 text-slate-400">{evidence.sourceUri}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <details className="rounded-[16px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                    <summary className="cursor-pointer list-none font-medium text-white">Why this is believed</summary>
                    <div className="mt-3 space-y-3">
                      <p>This answer comes from the current retrieval pass for <span className="font-medium text-white">{item.query ?? "the active lens"}</span> using the evidence shown above. If retrieval looks thin, treat the answer as a prompt to inspect source material, not divine truth.</p>
                      {item.query ? (
                        <Link href={`/console/query?query=${encodeURIComponent(item.query)}`} className="text-cyan-100 hover:text-white">
                          Open this question in Query
                        </Link>
                      ) : null}
                    </div>
                  </details>
                  <details className="rounded-[16px] border border-white/8 bg-black/15 p-4 text-sm leading-7 text-slate-300">
                    <summary className="cursor-pointer list-none font-medium text-white">What superseded the old value</summary>
                    <div className="mt-3 space-y-3">
                      <p className="text-slate-200">{item.historical?.answer ?? "No older signal surfaced yet."}</p>
                      {item.historical?.evidence.length ? (
                        <div className="space-y-2">
                          {item.historical.evidence.map((evidence) => (
                            <div key={`${item.title}:history:${evidence.sourceUri ?? evidence.snippet}`} className="rounded-[14px] border border-white/8 bg-white/5 p-3 text-xs leading-6 text-slate-300">
                              <p>{evidence.snippet}</p>
                              {evidence.sourceUri ? <p className="mt-1 text-slate-500">{evidence.sourceUri}</p> : null}
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
        </details>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Top blockers</CardDescription>
            <CardTitle>What is still making the brain squint</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topClarifications.length === 0 ? (
              <p className="text-sm leading-7 text-slate-300">No open clarification items right now. Either the brain is in good shape, or it is being suspiciously polite.</p>
            ) : (
              topClarifications.map((item) => (
                <Link
                  key={item.candidateId}
                  href={`/clarifications?namespace=${encodeURIComponent(namespaceId)}`}
                  className="block rounded-[20px] border border-white/8 bg-white/5 p-4 hover:bg-white/8"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        item.priorityLevel === 1
                          ? "border-rose-300/20 bg-rose-300/10 text-rose-100"
                          : item.priorityLevel === 2
                            ? "border-amber-300/20 bg-amber-300/10 text-amber-100"
                            : "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"
                      }
                    >
                      {item.priorityLabel}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      {item.ambiguityType.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <p className="mt-3 text-base font-semibold tracking-tight text-white">{item.rawText}</p>
                  <p className="mt-1 text-sm leading-7 text-slate-300">{item.ambiguityReason ?? "Needs grounding."}</p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </OperatorShell>
  );
}
