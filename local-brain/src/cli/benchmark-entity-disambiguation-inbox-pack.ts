import { closePool } from "../db/client.js";
import { runEntityDisambiguationInboxPackCli } from "../benchmark/entity-disambiguation-inbox-pack.js";

try {
  await runEntityDisambiguationInboxPackCli();
} finally {
  await closePool().catch(() => undefined);
}
