import { closePool } from "../db/client.js";
import { runMcpGoldFidelityResidualPackCli } from "../benchmark/mcp-gold-fidelity-residual-pack.js";

try {
  await runMcpGoldFidelityResidualPackCli();
} finally {
  await closePool();
}
