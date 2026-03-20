"use client";

import { Loader2 } from "lucide-react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

interface PendingSubmitButtonProps {
  readonly idleLabel: string;
  readonly pendingLabel: string;
  readonly className?: string;
  readonly variant?: "default" | "outline" | "destructive" | "ghost";
  readonly disabled?: boolean;
}

export function PendingSubmitButton({
  idleLabel,
  pendingLabel,
  className,
  variant = "default",
  disabled
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant={variant} disabled={disabled || pending} className={className}>
      {pending ? <Loader2 className="animate-spin" /> : null}
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}
