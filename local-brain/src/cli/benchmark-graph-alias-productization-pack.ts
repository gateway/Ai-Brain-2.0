import { runGraphAliasProductizationPackCli } from "../benchmark/graph-alias-productization-pack.js";
import { closePool } from "../db/client.js";

try {
  await runGraphAliasProductizationPackCli();
} finally {
  await closePool();
}
