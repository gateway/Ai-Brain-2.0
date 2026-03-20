import { ComingSoonPanel } from "@/components/coming-soon-panel";

export default function SessionGraphPage() {
  return (
    <ComingSoonPanel
      title="Session graph explorer"
      description="The existing Cytoscape graph remains available in the legacy console. The session-scoped graph contract comes next, once the workbench has explicit per-session graph payloads and expansion endpoints."
      legacyHref="/console/relationships"
    />
  );
}
