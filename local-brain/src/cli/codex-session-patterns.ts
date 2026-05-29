import path from "node:path";
import { defaultCodexSessionConfig, exportCodexSkillCandidateDrafts, mineCodexSessionPatterns } from "../codex-sessions/service.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const config = defaultCodexSessionConfig();
const namespaceId = argValue("--namespace") ?? config.namespaceId;

if (hasFlag("--export-draft")) {
  const outputDir = path.resolve(argValue("--output-dir") ?? "local-brain/benchmark-results/codex-skill-candidate-draft");
  const result = await exportCodexSkillCandidateDrafts({ namespaceId, outputDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const report = await mineCodexSessionPatterns({
    namespaceId,
    limit: argValue("--limit") ? Number(argValue("--limit")) : undefined
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
