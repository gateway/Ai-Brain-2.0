import { runProductionBattleBenchmarkCli } from "../benchmark/production-battle.js";

runProductionBattleBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
