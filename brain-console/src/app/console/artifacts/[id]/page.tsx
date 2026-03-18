import { ConsoleShell } from "@/components/console-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getArtifactDetail } from "@/lib/brain-runtime";

export default async function ArtifactDetailPage({
  params
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const artifact = await getArtifactDetail(id);

  return (
    <ConsoleShell
      currentPath="/console/artifacts"
      title="Artifact Detail"
      subtitle="Durable source-of-truth view across observations, derivations, and linked episodic evidence."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Artifact</CardDescription>
            <CardTitle className="font-mono text-base">{artifact.artifactId}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>Namespace: {artifact.namespaceId}</p>
            <p>Source type: {artifact.sourceType}</p>
            <p className="break-all">Source URI: {artifact.sourceUri}</p>
            <p>Chunk count: {artifact.chunkCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Linked memory</CardDescription>
            <CardTitle>Episodic evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {artifact.episodicHits.length === 0 ? (
              <p>No episodic hits recorded yet.</p>
            ) : (
              artifact.episodicHits.map((hit) => (
                <div key={hit.id} className="rounded-2xl border border-slate-900/10 bg-slate-50 p-3">
                  <p className="font-mono text-xs text-slate-500">{hit.id}</p>
                  <p className="mt-2">{hit.content}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Observations</CardDescription>
          <CardTitle>Versioned source history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b">
                  <th className="h-10 px-2 text-left font-medium">Observation</th>
                  <th className="h-10 px-2 text-left font-medium">Observed at</th>
                  <th className="h-10 px-2 text-left font-medium">Hash</th>
                  <th className="h-10 px-2 text-left font-medium">Bytes</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
              {artifact.observations.map((observation) => (
                <tr key={observation.artifactObservationId} className="border-b align-top">
                  <td className="p-2 font-mono text-xs">{observation.artifactObservationId}</td>
                  <td className="p-2">{observation.observedAt}</td>
                  <td className="p-2 font-mono text-xs">{observation.contentHash}</td>
                  <td className="p-2">{observation.byteSize}</td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Derivations</CardDescription>
          <CardTitle>OCR, captions, summaries, text proxies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {artifact.derivations.length === 0 ? (
            <p className="text-sm text-slate-600">No derivations recorded for this artifact yet.</p>
          ) : (
            artifact.derivations.map((derivation) => (
              <div key={derivation.artifactDerivationId} className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs text-slate-500">{derivation.artifactDerivationId}</p>
                  <p className="text-sm text-slate-500">
                    {derivation.derivationType}
                    {derivation.provider ? ` · ${derivation.provider}` : ""}
                    {derivation.model ? `/${derivation.model}` : ""}
                  </p>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{derivation.contentText}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
