import { closePool } from "../db/client.js";
import { runLocalEvaluation, writeEvalReport } from "../eval/runner.js";

async function main(): Promise<void> {
  try {
    const report = await runLocalEvaluation();
    const output = await writeEvalReport(report);
    console.log(
      JSON.stringify(
        {
          report,
          output
        },
        null,
        2
      )
    );
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
