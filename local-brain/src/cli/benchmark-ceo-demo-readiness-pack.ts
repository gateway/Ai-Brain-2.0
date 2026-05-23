import { runCeoDemoReadinessPackCli } from "../benchmark/ceo-demo-readiness-pack.js";

runCeoDemoReadinessPackCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
