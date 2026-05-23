#!/usr/bin/env node
import { runOperatorDashboardCli } from "../benchmark/operator-dashboard.js";

runOperatorDashboardCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
