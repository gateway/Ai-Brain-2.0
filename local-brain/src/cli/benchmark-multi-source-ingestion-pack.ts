import { runMultiSourceIngestionPackCli } from "../benchmark/multi-source-ingestion-pack.js";

runMultiSourceIngestionPackCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
