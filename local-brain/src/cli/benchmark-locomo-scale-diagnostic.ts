import { runLoCoMoScaleDiagnosticCli } from "../benchmark/locomo-scale-diagnostic.js";

runLoCoMoScaleDiagnosticCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

