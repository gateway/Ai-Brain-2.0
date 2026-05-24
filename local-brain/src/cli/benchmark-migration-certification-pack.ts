import { runMigrationCertificationPackCli } from "../benchmark/migration-certification-pack.js";

runMigrationCertificationPackCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
