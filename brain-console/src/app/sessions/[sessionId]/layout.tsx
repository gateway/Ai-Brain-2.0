import type { ReactNode } from "react";
import { SessionShell } from "@/components/session-shell";
import { getWorkbenchSession } from "@/lib/operator-workbench";

export default async function SessionLayout({
  children,
  params
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await getWorkbenchSession(sessionId);

  return (
    <SessionShell session={session}>{children}</SessionShell>
  );
}
