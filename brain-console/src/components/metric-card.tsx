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
  default: "border-white/8 bg-[linear-gradient(180deg,_rgba(20,24,33,0.94)_0%,_rgba(10,13,19,0.98)_100%)] text-white",
  success: "border-emerald-400/20 bg-[linear-gradient(180deg,_rgba(10,34,26,0.96)_0%,_rgba(7,18,15,0.98)_100%)] text-white",
  warning: "border-amber-300/20 bg-[linear-gradient(180deg,_rgba(40,24,10,0.96)_0%,_rgba(19,13,7,0.98)_100%)] text-white",
  danger: "border-rose-400/20 bg-[linear-gradient(180deg,_rgba(41,14,18,0.96)_0%,_rgba(20,8,10,0.98)_100%)] text-white"
};

export function MetricCard({ title, value, detail, tone = "default", footer }: MetricCardProps) {
  return (
    <Card className={toneClasses[tone]}>
      <CardHeader>
        <CardDescription className="font-mono text-[11px] uppercase tracking-[0.32em] text-slate-500">{title}</CardDescription>
        <CardTitle className="text-3xl text-white">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {detail ? <p className="text-sm leading-6 text-slate-400">{detail}</p> : null}
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
