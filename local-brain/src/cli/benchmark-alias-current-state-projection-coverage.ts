import { runAliasCurrentStateProjectionCoverageCli } from "../benchmark/alias-current-state-projection-coverage.js";

runAliasCurrentStateProjectionCoverageCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
