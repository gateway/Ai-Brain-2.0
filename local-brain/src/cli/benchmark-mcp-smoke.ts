import { runMcpSmokeBenchmarkCli } from "../benchmark/mcp-smoke.js";

runMcpSmokeBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
