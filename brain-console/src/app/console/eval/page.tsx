import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getLatestEval } from "@/lib/brain-runtime";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function EvalPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const report = await getLatestEval();
  const passedChecks = report.json.checks.filter((item) => item.passed).length;
  const status = readParam(params.status);
  const message = readParam(params.message);

  return (
    <ConsoleShell
      currentPath="/console/eval"
      title="Evaluation"
      subtitle="Latest full local-brain evaluation run, including ingestion, retrieval, provenance, temporal, relationship, and token-burn checks."
    >
      <div className="flex flex-wrap items-center gap-3">
        <form action="/console/eval/run" method="post">
          <button
            type="submit"
            className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Run eval now
          </button>
        </form>
        {status ? <StatusBadge value={status === "ok" ? "eval complete" : "eval error"} /> : null}
        {message ? <p className="text-sm text-rose-700">{message}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Generated</CardDescription>
            <CardTitle>{new Date(report.json.generatedAt).toLocaleString()}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Checks passed</CardDescription>
            <CardTitle>
              {passedChecks}/{report.json.checks.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Namespace</CardDescription>
            <CardTitle className="font-mono text-base">{report.json.namespaceId}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Check matrix</CardDescription>
          <CardTitle>Latest verification pass</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b">
                  <th className="h-10 px-2 text-left font-medium">Check</th>
                  <th className="h-10 px-2 text-left font-medium">Status</th>
                  <th className="h-10 px-2 text-left font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
              {report.json.checks.map((check) => (
                <tr key={check.name} className="border-b align-top">
                  <td className="p-2 font-mono text-xs">{check.name}</td>
                  <td className="p-2">
                    <StatusBadge value={check.passed ? "pass" : "fail"} />
                  </td>
                  <td className="p-2 text-sm text-slate-600">{check.details}</td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Metrics</CardDescription>
          <CardTitle>Current retrieval and memory totals</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Object.entries(report.json.metrics).map(([key, value]) => (
            <div key={key} className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
              <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-500">{key}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
