import { runHumanQueryContractRoutingCli } from "../benchmark/human-query-contract-routing.js";

runHumanQueryContractRoutingCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
