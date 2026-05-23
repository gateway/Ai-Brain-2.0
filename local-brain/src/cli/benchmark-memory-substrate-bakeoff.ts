import { runMemorySubstrateBakeoffCli } from "../benchmark/memory-substrate-bakeoff.js";

runMemorySubstrateBakeoffCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
