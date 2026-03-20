import { ClarificationWorkbench } from "@/components/clarification-workbench";
import { SessionShell } from "@/components/session-shell";
import { getWorkbenchClarifications, getWorkbenchSession } from "@/lib/operator-workbench";

export default async function SessionClarificationsPage({
  params
}: {
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await getWorkbenchSession(sessionId);
  const clarifications = await getWorkbenchClarifications(session.namespaceId, 24).catch(() => null);

  return (
    <SessionShell
      session={session}
      title="Clarifications"
      subtitle="Resolve ambiguous names, kinship labels, places, aliases, and other uncertain references for this session namespace."
    >
      <ClarificationWorkbench
        namespaceId={session.namespaceId}
        clarifications={clarifications}
        redirectPath={`/sessions/${session.id}/clarifications`}
        title="Session clarification workspace"
        description="These corrections feed back into the brain through the controlled clarification endpoints so graph state, relationship state, and later recall can update cleanly."
        limit={24}
      />
    </SessionShell>
  );
}
