import { closePool } from "../db/client.js";
import { runMcpCorrectionPropagationPackCli } from "../benchmark/mcp-correction-propagation-pack.js";

try {
  await runMcpCorrectionPropagationPackCli();
} finally {
  await closePool();
}
