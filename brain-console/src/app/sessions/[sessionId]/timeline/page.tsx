import { ComingSoonPanel } from "@/components/coming-soon-panel";

export default function SessionTimelinePage() {
  return (
    <ComingSoonPanel
      title="Session timeline inspection"
      description="The timeline surface will become session-aware in the next slice so evidence and summaries can be explored from a single intake context before widening globally."
      legacyHref="/console/timeline"
    />
  );
}
