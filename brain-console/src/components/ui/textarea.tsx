import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-36 w-full rounded-2xl border border-input bg-transparent px-4 py-3 text-[15px] text-foreground outline-none transition-colors placeholder:text-slate-400 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#17202b] dark:text-white",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
