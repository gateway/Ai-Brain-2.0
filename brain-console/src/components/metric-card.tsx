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
  default: "border-slate-900/10 bg-white",
  success: "border-emerald-400/35 bg-emerald-50/80",
  warning: "border-amber-400/35 bg-amber-50/80",
  danger: "border-rose-400/35 bg-rose-50/80"
};

export function MetricCard({ title, value, detail, tone = "default", footer }: MetricCardProps) {
  return (
    <Card className={toneClasses[tone]}>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {detail ? <p className="text-sm leading-6 text-slate-600">{detail}</p> : null}
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

  return <Badge variant={variant}>{value}</Badge>;
}
