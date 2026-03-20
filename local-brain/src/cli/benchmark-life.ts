import { runAndWriteLifeReplayBenchmark } from "../benchmark/life-replay.js";

async function main(): Promise<void> {
  const result = await runAndWriteLifeReplayBenchmark();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
