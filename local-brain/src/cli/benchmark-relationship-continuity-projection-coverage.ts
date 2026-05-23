import { runRelationshipContinuityProjectionCoverageCli } from "../benchmark/relationship-continuity-projection-coverage.js";

runRelationshipContinuityProjectionCoverageCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
