import Link from "next/link";
import { OperatorShell } from "@/components/operator-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOpsOverview } from "@/lib/brain-runtime";
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
    answer: formatAnswer(response, fallback),
    evidence: compactEvidence(response),
    retrievalMode: typeof response.meta.retrievalMode === "string" ? response.meta.retrievalMode : "unknown",
    fallbackReason: typeof response.meta.fallbackReason === "string" ? response.meta.fallbackReason : undefined
  };
}

export default async function KnowledgePage() {
  await requireSetupComplete("/knowledge");

  const bootstrap = await getBootstrapState();
  const namespaceId = bootstrap.metadata.defaultNamespaceId ?? "personal";

  const [selfProfile, clarifications, overview, home, projects, people, routines, beliefs, preferences] = await Promise.all([
    getWorkbenchSelfProfile(namespaceId).catch(() => null),
    getWorkbenchClarifications(namespaceId, 10).catch(() => null),
    getOpsOverview().catch(() => null),
    loadQueryCard(namespaceId, "where do I live?", "The brain has not verified your current home yet."),
    loadQueryCard(namespaceId, "what am I working on?", "No active project answer yet."),
    loadQueryCard(namespaceId, "who are my friends?", "Important people are not grounded clearly yet."),
    loadQueryCard(namespaceId, "what routines do I have?", "No stable routine answer yet."),
    loadQueryCard(namespaceId, "what is my current stance on infrastructure?", "No active belief summary yet."),
    loadQueryCard(namespaceId, "what do I like?", "Preferences are still too foggy.")
  ]);

  const topClarifications = clarifications?.items.slice(0, 5) ?? [];

  return (
    <OperatorShell
      currentPath="/knowledge"
      title="What It Knows"
      subtitle="This is the operator-facing readout of what the brain currently believes, what evidence supports it, and where the confidence still breaks down."
    >
      <div className="space-y-6">
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="border-white/8 bg-[radial-gradient(circle_at_top_right,_rgba(103,232,249,0.08),_transparent_28%),linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
            <CardHeader>
              <CardDescription>Knowledge surface</CardDescription>
              <CardTitle>The current shape of the brain</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-7 text-slate-300">
              <p>This page is the clean answer to “what does the brain think is true right now?” It favors grounded answers, visible evidence, and honest uncertainty over sounding clever.</p>
              <p>If something here looks wrong, the next place to go is almost always <Link href="/clarifications" className="font-medium text-cyan-100 hover:text-white">Clarifications</Link> or <Link href="/sources" className="font-medium text-cyan-100 hover:text-white">Sources</Link>, not vague optimism.</p>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Self anchor</CardDescription>
                <CardTitle className="text-lg text-white">{selfProfile?.canonicalName ?? "missing"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{selfProfile ? `${selfProfile.aliases.length} aliases saved.` : "No explicit self profile bound yet."}</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Clarifications</CardDescription>
                <CardTitle className="text-lg text-white">{clarifications?.summary.total ?? 0}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">{clarifications?.summary.byPriority.priority_1 ?? 0} priority 1 unknowns are still blocking clean grounding.</CardContent>
            </Card>
            <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
              <CardHeader className="pb-2">
                <CardDescription>Memory pressure</CardDescription>
                <CardTitle className="text-lg text-white">{overview?.memorySummary.clarificationPending ?? "?"}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-300">Open clarification rows across the runtime view of this brain.</CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {[
            { title: "Self identity", description: "Who this brain belongs to", answer: selfProfile ? `${selfProfile.canonicalName}${selfProfile.aliases.length ? ` · aliases: ${selfProfile.aliases.join(", ")}` : ""}` : "No self profile has been saved yet.", evidence: [] as const, retrievalMode: "profile" },
            { title: "Current location", description: "Where the brain believes you live", ...home },
            { title: "Current projects", description: "What the brain thinks is active right now", ...projects },
            { title: "Important people", description: "Who keeps showing up in your graph", ...people },
            { title: "Routines", description: "Stable patterns the brain thinks you repeat", ...routines },
            { title: "Current beliefs", description: "Active stance, not old debate residue", ...beliefs },
            { title: "Preferences", description: "Tastes and likes that have enough evidence to matter", ...preferences }
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
              </CardContent>
            </Card>
          ))}
        </div>

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
