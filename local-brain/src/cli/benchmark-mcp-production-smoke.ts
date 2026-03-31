import { runMcpProductionSmokeBenchmarkCli } from "../benchmark/mcp-production-smoke.js";

runMcpProductionSmokeBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
