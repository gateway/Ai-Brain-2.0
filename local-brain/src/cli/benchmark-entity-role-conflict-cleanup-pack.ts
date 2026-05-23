import { closePool } from "../db/client.js";
import { runEntityRoleConflictCleanupPackCli } from "../benchmark/entity-role-conflict-cleanup-pack.js";

try {
  await runEntityRoleConflictCleanupPackCli();
} finally {
  await closePool();
}
