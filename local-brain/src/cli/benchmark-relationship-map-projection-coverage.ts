import { runRelationshipMapProjectionCoverageCli } from "../benchmark/relationship-map-projection-coverage.js";

runRelationshipMapProjectionCoverageCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
