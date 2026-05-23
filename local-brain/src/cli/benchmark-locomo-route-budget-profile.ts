import { runLoCoMoRouteBudgetProfileCli } from "../benchmark/locomo-route-budget-profile.js";

runLoCoMoRouteBudgetProfileCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

