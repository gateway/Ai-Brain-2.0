import { closePool } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";

async function main(): Promise<void> {
  try {
    const applied = await runMigrations();

    if (applied.length === 0) {
      console.log("No new migrations applied.");
      return;
    }

    console.log("Applied migrations:");
    for (const name of applied) {
      console.log(`- ${name}`);
    }
  } finally {
    await closePool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
