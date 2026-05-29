import { scanCodexSessions, defaultCodexSessionConfig, type CodexArchivePolicy } from "../codex-sessions/service.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const config = defaultCodexSessionConfig();
const report = await scanCodexSessions(config, {
  dryRun: hasFlag("--dry-run"),
  includeArchived: !hasFlag("--no-archived"),
  since: argValue("--since"),
  repo: argValue("--repo"),
  project: argValue("--project"),
  limit: argValue("--limit") ? Number(argValue("--limit")) : undefined,
  maxBytes: argValue("--max-bytes") ? Number(argValue("--max-bytes")) : undefined,
  archivePolicy: (argValue("--archive-policy") as CodexArchivePolicy | undefined) ?? undefined
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
