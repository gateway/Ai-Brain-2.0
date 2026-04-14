import { closePool } from "../db/client.js";
import { runAndWriteLoCoMoFullResidualReview } from "../benchmark/locomo-full-residual-review.js";

async function main(): Promise<void> {
  const { report, output } = await runAndWriteLoCoMoFullResidualReview();
  process.stdout.write(
    `${JSON.stringify(
      {
        passRate: report.passRate,
        failingCount: report.failingCount,
        output,
        recommendedTracks: report.recommendedTracks
      },
      null,
      2
    )}\n`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
