import { runEvidenceTelemetryProfileCli } from "../benchmark/evidence-telemetry-profile.js";

runEvidenceTelemetryProfileCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

