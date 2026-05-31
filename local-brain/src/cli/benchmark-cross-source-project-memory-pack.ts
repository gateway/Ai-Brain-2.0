import { closePool } from "../db/client.js";
import { runCrossSourceProjectMemoryPackCli } from "../benchmark/cross-source-project-memory-pack.js";

try {
  await runCrossSourceProjectMemoryPackCli();
} finally {
  await closePool().catch(() => undefined);
}
