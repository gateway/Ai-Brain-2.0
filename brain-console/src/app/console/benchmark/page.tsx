import { ConsoleShell } from "@/components/console-shell";
import { StatusBadge } from "@/components/metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getLatestBenchmark } from "@/lib/brain-runtime";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function BenchmarkPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const params = await searchParams;
  const report = await getLatestBenchmark();
  const status = readParam(params.status);
  const message = readParam(params.message);

  return (
    <ConsoleShell
      currentPath="/console/benchmark"
      title="Lexical Benchmark"
      subtitle="Side-by-side lexical stress results for native PostgreSQL FTS and BM25, with fallback, result counts, and approximate token burn."
    >
      <div className="flex flex-wrap items-center gap-3">
        <form action="/console/benchmark/run" method="post">
          <button
            type="submit"
            className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Run benchmark now
          </button>
        </form>
        {status ? <StatusBadge value={status === "ok" ? "benchmark complete" : "benchmark error"} /> : null}
        {message ? <p className="text-sm text-rose-700">{message}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>FTS passed</CardDescription>
            <CardTitle>
              {report.json.summary.ftsPassed}/{report.json.summary.totalCases}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>BM25 passed</CardDescription>
            <CardTitle>
              {report.json.summary.bm25Passed}/{report.json.summary.totalCases}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>BM25 token delta</CardDescription>
            <CardTitle>{report.json.summary.bm25TokenDelta}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Recommendation</CardDescription>
            <CardTitle className="text-base">
              <StatusBadge value={report.json.summary.recommendation} />
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardDescription>Current gate</CardDescription>
          <CardTitle>{report.json.summary.reason}</CardTitle>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardDescription>Case matrix</CardDescription>
          <CardTitle>FTS vs BM25</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b">
                  <th className="h-10 px-2 text-left font-medium">Case</th>
                  <th className="h-10 px-2 text-left font-medium">Provider</th>
                  <th className="h-10 px-2 text-left font-medium">Status</th>
                  <th className="h-10 px-2 text-left font-medium">Fallback</th>
                  <th className="h-10 px-2 text-left font-medium">Top type</th>
                  <th className="h-10 px-2 text-left font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
              {report.json.cases.map((testCase) => (
                <tr key={`${testCase.name}-${testCase.provider}`} className="border-b align-top">
                  <td className="p-2 font-mono text-xs">{testCase.name}</td>
                  <td className="p-2">{testCase.provider}</td>
                  <td className="p-2">
                    <StatusBadge value={testCase.passed ? "pass" : "fail"} />
                  </td>
                  <td className="p-2">{testCase.lexicalFallbackUsed ? "yes" : "no"}</td>
                  <td className="p-2">{testCase.topMemoryType ?? "n/a"}</td>
                  <td className="p-2">{testCase.approxTokens ?? "n/a"}</td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </ConsoleShell>
  );
}
