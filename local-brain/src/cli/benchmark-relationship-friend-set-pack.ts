import { runRelationshipFriendSetPackCli } from "../benchmark/relationship-friend-set-pack.js";
import { closePool } from "../db/client.js";

try {
  await runRelationshipFriendSetPackCli();
} finally {
  await closePool();
}
