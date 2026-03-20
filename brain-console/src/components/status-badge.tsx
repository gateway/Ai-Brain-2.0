import { Badge } from "@/components/ui/badge";

const variantByStatus: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  intake_in_progress: "secondary",
  awaiting_review: "default",
  clarifications_open: "secondary",
  reprocessing: "secondary",
  completed: "default",
  failed: "destructive",
  archived: "outline",
  classified: "default",
  review_ready: "default",
  queued: "outline",
  uploaded: "outline",
  derived: "secondary",
  awaiting_adapter: "outline",
  unsupported: "destructive"
};

function formatStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export function StatusBadge({ status }: { readonly status: string }) {
  return (
    <Badge variant={variantByStatus[status] ?? "outline"} className="capitalize">
      {formatStatusLabel(status)}
    </Badge>
  );
}
