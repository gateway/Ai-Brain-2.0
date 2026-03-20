import { runAndWriteLifeScaleBenchmark } from "../benchmark/life-scale.js";

async function main(): Promise<void> {
  const result = await runAndWriteLifeScaleBenchmark();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
