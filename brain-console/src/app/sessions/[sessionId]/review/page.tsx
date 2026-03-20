import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getWorkbenchSessionReview } from "@/lib/operator-workbench";

function confidenceTone(confidence?: number): string {
  if (confidence === undefined) {
    return "border-white/10 bg-white/5 text-slate-100";
  }
  if (confidence >= 0.85) {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  }
  if (confidence >= 0.6) {
    return "border-amber-300/20 bg-amber-300/10 text-amber-100";
  }
  return "border-rose-400/20 bg-rose-400/10 text-rose-100";
}

export default async function SessionReviewPage({
  params
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  const review = await getWorkbenchSessionReview(sessionId);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        <Metric title="Entities" value={review.summary.entityCount} />
        <Metric title="Relationships" value={review.summary.relationshipCount} />
        <Metric title="Claims" value={review.summary.claimCount} />
        <Metric title="Unresolved" value={review.summary.unresolvedCount} />
      </div>

      <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
        <CardHeader>
          <CardDescription>Source context</CardDescription>
          <CardTitle>What entered the session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {review.sources.length === 0 ? (
            <p className="text-sm text-slate-300">No source inputs are attached to this session yet.</p>
          ) : (
            review.sources.map((source) => (
              <div key={source.id} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{source.label ?? source.inputType}</p>
                    <p className="text-xs text-slate-400">{new Date(source.createdAt).toLocaleString()}</p>
                  </div>
                  <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                    {source.status}
                  </Badge>
                </div>
                {source.rawText ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-300">
                    {source.rawText.slice(0, 1200)}
                    {source.rawText.length > 1200 ? "..." : ""}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Entity candidates</CardDescription>
            <CardTitle>Detected entities tied to this session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {review.entities.length === 0 ? (
              <p className="text-sm text-slate-300">No entity candidates were detected yet.</p>
            ) : (
              review.entities.map((entity) => (
                <div key={entity.entityId} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-white">{entity.displayLabel}</p>
                      <p className="text-xs text-slate-400">{entity.entityType}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className={confidenceTone(entity.confidence)}>
                        {entity.confidence !== undefined ? `${Math.round(entity.confidence * 100)}%` : "n/a"}
                      </Badge>
                      <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                        evidence {entity.evidenceCount}
                      </Badge>
                    </div>
                  </div>
                  {entity.aliases.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {entity.aliases.slice(0, 6).map((alias) => (
                        <Badge key={`${entity.entityId}:${alias}`} variant="outline" className="border-teal-400/20 bg-teal-400/10 text-teal-100">
                          {alias}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Relationship candidates</CardDescription>
            <CardTitle>Edges staged from this session</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {review.relationships.length === 0 ? (
              <p className="text-sm text-slate-300">No relationship candidates were detected yet.</p>
            ) : (
              review.relationships.map((relationship) => (
                <div key={relationship.relationshipId} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={confidenceTone(relationship.confidence)}>
                      {relationship.confidence !== undefined ? `${Math.round(relationship.confidence * 100)}%` : "n/a"}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      {relationship.status}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm font-medium text-white">
                    {relationship.subject} <span className="text-amber-200">{relationship.predicate}</span> {relationship.object}
                  </p>
                  {relationship.sourceRef ? <p className="mt-2 text-xs text-slate-400">source {relationship.sourceRef}</p> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Claim candidates</CardDescription>
            <CardTitle>Facts and summaries awaiting operator trust</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {review.claims.length === 0 ? (
              <p className="text-sm text-slate-300">No claim candidates are available for this session yet.</p>
            ) : (
              review.claims.map((claim) => (
                <div key={claim.claimId} className="rounded-[20px] border border-white/8 bg-white/5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={confidenceTone(claim.confidence)}>
                      {claim.confidence !== undefined ? `${Math.round(claim.confidence * 100)}%` : "n/a"}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      {claim.claimType}
                    </Badge>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                      {claim.status}
                    </Badge>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-slate-300">{claim.normalizedText}</p>
                  {claim.ambiguityReason ? <p className="mt-2 text-xs text-amber-100">{claim.ambiguityReason}</p> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
          <CardHeader>
            <CardDescription>Unresolved items</CardDescription>
            <CardTitle>What still needs operator clarification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {review.unresolvedItems.length === 0 ? (
              <p className="text-sm text-slate-300">No unresolved identity or relationship issues were found for this session.</p>
            ) : (
              review.unresolvedItems.map((item) => (
                <div key={item.claimId} className="rounded-[20px] border border-amber-300/20 bg-amber-300/10 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-amber-300/25 bg-amber-300/12 text-amber-50">
                      {item.ambiguityType?.replace(/_/g, " ") ?? "requires operator confirmation"}
                    </Badge>
                    {item.confidence !== undefined ? (
                      <Badge variant="outline" className={confidenceTone(item.confidence)}>
                        {Math.round(item.confidence * 100)}%
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-3 font-medium text-white">{item.title}</p>
                  <p className="mt-2 text-sm leading-7 text-slate-200">{item.description}</p>
                  {item.suggestions.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.suggestions.map((suggestion) => (
                        <Badge key={`${item.claimId}:${suggestion}`} variant="outline" className="border-white/10 bg-white/5 text-slate-100">
                          {suggestion}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ title, value }: { readonly title: string; readonly value: number }) {
  return (
    <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
