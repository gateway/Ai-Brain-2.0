import { runLoCoMoDriftAudit } from "../benchmark/locomo-drift-audit.js";

function parseArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const baseline = parseArg("--baseline");
  const candidate = parseArg("--candidate");
  if (!baseline || !candidate) {
    throw new Error("Usage: node dist/cli/benchmark-locomo-drift-audit.js --baseline <path> --candidate <path>");
  }
  const result = await runLoCoMoDriftAudit(baseline, candidate);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
