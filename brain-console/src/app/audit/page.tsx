import { ComingSoonPanel } from "@/components/coming-soon-panel";
import { OperatorShell } from "@/components/operator-shell";
import { requireSetupComplete } from "@/lib/setup-gating";

export default async function AuditPage() {
  await requireSetupComplete("/audit");
  return (
    <OperatorShell
      currentPath="/audit"
      title="Audit"
      subtitle="Operator actions, review submissions, and later query/model events will become explicit and inspectable here."
    >
      <ComingSoonPanel
        title="Audit log"
        description="The backend now records session actions for the new session/intake slice. The dedicated audit UI lands next so operators can inspect that history without using raw SQL."
      />
    </OperatorShell>
  );
}
