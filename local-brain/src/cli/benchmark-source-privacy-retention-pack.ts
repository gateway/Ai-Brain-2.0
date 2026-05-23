#!/usr/bin/env node
import { runSourcePrivacyRetentionPackCli } from "../benchmark/source-privacy-retention-pack.js";

runSourcePrivacyRetentionPackCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
