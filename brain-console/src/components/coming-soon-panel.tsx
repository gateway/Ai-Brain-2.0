import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ComingSoonPanel({
  title,
  description,
  legacyHref
}: {
  readonly title: string;
  readonly description: string;
  readonly legacyHref?: string;
}) {
  return (
    <Card className="border-white/8 bg-[linear-gradient(180deg,_rgba(18,24,34,0.96)_0%,_rgba(8,11,20,0.98)_100%)]">
      <CardHeader>
        <CardDescription>Next slice</CardDescription>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-7 text-slate-300">
        <p>{description}</p>
        {legacyHref ? (
          <Link
            href={legacyHref}
            className="inline-flex items-center rounded-2xl border border-white/10 bg-white/5 px-4 py-2 font-medium text-white hover:border-white/15 hover:bg-white/8"
          >
            Open legacy console surface
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
