import { defaultCodexSessionConfig, projectCodexSessionSpecCoverage } from "../codex-sessions/service.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const config = defaultCodexSessionConfig();
const report = await projectCodexSessionSpecCoverage({
  namespaceId: argValue("--namespace") ?? config.namespaceId,
  limit: argValue("--limit") ? Number(argValue("--limit")) : undefined
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
