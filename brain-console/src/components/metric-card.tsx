import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface MetricCardProps {
  readonly title: string;
  readonly value: string | number;
  readonly detail?: string;
  readonly tone?: "default" | "success" | "warning" | "danger";
  readonly footer?: ReactNode;
}

const toneClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "rounded-[28px] border-white/8 bg-[linear-gradient(180deg,_rgba(20,24,33,0.84)_0%,_rgba(10,13,19,0.9)_100%)] text-white shadow-[0_10px_28px_rgba(0,0,0,0.14)]",
  success: "rounded-[28px] border-emerald-400/18 bg-[linear-gradient(180deg,_rgba(10,34,26,0.86)_0%,_rgba(7,18,15,0.9)_100%)] text-white shadow-[0_10px_28px_rgba(0,0,0,0.14)]",
  warning: "rounded-[28px] border-amber-300/18 bg-[linear-gradient(180deg,_rgba(40,24,10,0.86)_0%,_rgba(19,13,7,0.9)_100%)] text-white shadow-[0_10px_28px_rgba(0,0,0,0.14)]",
  danger: "rounded-[28px] border-rose-400/18 bg-[linear-gradient(180deg,_rgba(41,14,18,0.86)_0%,_rgba(20,8,10,0.9)_100%)] text-white shadow-[0_10px_28px_rgba(0,0,0,0.14)]"
};

export function MetricCard({ title, value, detail, tone = "default", footer }: MetricCardProps) {
  return (
    <Card className={toneClasses[tone]}>
      <CardHeader>
        <CardDescription className="premium-eyebrow text-slate-200">{title}</CardDescription>
        <CardTitle className="text-[2rem] font-semibold tracking-[-0.04em] text-white">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {detail ? <p className="text-sm leading-7 text-slate-300">{detail}</p> : null}
        {footer ? footer : null}
      </CardContent>
    </Card>
  );
}

export function StatusBadge({ value }: { readonly value: string }) {
  const normalized = value.toLowerCase();
  const variant =
    normalized.includes("pass") || normalized.includes("ready") || normalized.includes("bm25")
      ? "default"
      : normalized.includes("fail") || normalized.includes("error")
        ? "destructive"
        : "secondary";

  return <Badge variant={variant} className="backdrop-blur">{value}</Badge>;
}
