import { runCertification98Cli } from "../benchmark/certification-98.js";

runCertification98Cli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
