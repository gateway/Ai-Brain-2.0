import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../config.js";
import { withTransaction } from "./client.js";

function defaultMigrationsDir(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, "../../migrations");
}

export async function resolveMigrationsDir(): Promise<string> {
  const config = readConfig();
  return config.migrationsDir || defaultMigrationsDir();
}

export async function listMigrationFiles(): Promise<string[]> {
  const migrationsDir = await resolveMigrationsDir();
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function runMigrations(): Promise<string[]> {
  const migrationsDir = await resolveMigrationsDir();
  const migrationFiles = await listMigrationFiles();
  const applied: string[] = [];

  await withTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const existingNames = new Set(existing.rows.map((row: { name: string }) => row.name));

    for (const migrationFile of migrationFiles) {
      if (existingNames.has(migrationFile)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, migrationFile), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migrationFile]);
      applied.push(migrationFile);
    }
  });

  return applied;
}
