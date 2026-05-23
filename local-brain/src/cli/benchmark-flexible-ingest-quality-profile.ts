import { runFlexibleIngestQualityProfileCli } from "../benchmark/flexible-ingest-quality-profile.js";

runFlexibleIngestQualityProfileCli().catch((error) => {
  console.error(error);
  process.exit(1);
});

