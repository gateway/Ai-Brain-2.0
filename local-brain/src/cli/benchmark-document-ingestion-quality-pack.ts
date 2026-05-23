import { runDocumentIngestionQualityPackCli } from "../benchmark/document-ingestion-quality-pack.js";

runDocumentIngestionQualityPackCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
