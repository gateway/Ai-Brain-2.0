import { runCompilerCacheProfileCli } from "../benchmark/compiler-cache-profile.js";

runCompilerCacheProfileCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
