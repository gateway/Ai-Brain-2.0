import { runSourceIntelligenceTaxonomyRoutingCli } from "../benchmark/source-intelligence-taxonomy-routing.js";

runSourceIntelligenceTaxonomyRoutingCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
