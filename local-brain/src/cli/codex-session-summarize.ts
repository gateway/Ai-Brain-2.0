import { defaultCodexSessionConfig, listPendingCodexSessionCatalogRows, parseAndSummarizeCodexSession } from "../codex-sessions/service.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const sourcePath = argValue("--session") ?? argValue("--path");
const pending = hasFlag("--pending");
const config = defaultCodexSessionConfig();

if (pending) {
  const limit = argValue("--limit") ? Number(argValue("--limit")) : 10;
  const rows = await listPendingCodexSessionCatalogRows(config.namespaceId, limit);
  const results = [];
  for (const row of rows) {
    const result = await parseAndSummarizeCodexSession({
      namespaceId: config.namespaceId,
      sourcePath: row.source_path,
      persist: true
    });
    results.push({ sourcePath: row.source_path, parse: result.parse.metrics, summary: result.summary.metrics });
  }
  process.stdout.write(`${JSON.stringify({ pendingCount: rows.length, results }, null, 2)}\n`);
  process.exit(0);
}

if (!sourcePath) {
  throw new Error("codex-session-summarize requires --session <path>.");
}

const result = await parseAndSummarizeCodexSession({
  namespaceId: config.namespaceId,
  sourcePath,
  persist: hasFlag("--persist")
});

process.stdout.write(`${JSON.stringify({ parse: result.parse.metrics, summary: result.summary }, null, 2)}\n`);
