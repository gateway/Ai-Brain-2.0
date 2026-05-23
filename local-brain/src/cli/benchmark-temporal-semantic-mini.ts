import { runTemporalSemanticMiniBenchmarkCli } from "../benchmark/temporal-semantic-mini.js";

runTemporalSemanticMiniBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
