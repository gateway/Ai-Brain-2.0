import { ComingSoonPanel } from "@/components/coming-soon-panel";

export default function SessionQueryPage() {
  return (
    <ComingSoonPanel
      title="Read-only session query workbench"
      description="Search, timeline query, and safe SQL remain planned for a dedicated session-scoped workbench slice. The underlying legacy console query route still exists for runtime validation."
      legacyHref="/console/query"
    />
  );
}
