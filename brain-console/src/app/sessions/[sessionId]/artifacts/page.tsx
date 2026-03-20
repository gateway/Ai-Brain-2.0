import { ComingSoonPanel } from "@/components/coming-soon-panel";

export default function SessionArtifactsPage() {
  return (
    <ComingSoonPanel
      title="Session artifact browser"
      description="Raw and derived artifact browsing is part of the next slice. The backend now records session-linked artifacts, and this page will expand into preview, derivation, and provenance inspection."
      legacyHref="/console/artifacts"
    />
  );
}
