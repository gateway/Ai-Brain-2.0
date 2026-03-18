import { closePool } from "../db/client.js";
import { startMcpStdioServer } from "../mcp/server.js";

async function main(): Promise<void> {
  try {
    await startMcpStdioServer();
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
