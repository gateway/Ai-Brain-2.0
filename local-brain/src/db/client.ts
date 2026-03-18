import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readConfig } from "../config.js";

let sharedPool: Pool | undefined;

export function getPool(): Pool {
  if (!sharedPool) {
    const config = readConfig();
    sharedPool = new Pool({
      connectionString: config.databaseUrl
    });
  }

  return sharedPool;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");

    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function queryRows<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, [...values]);
  return result.rows;
}

export async function closePool(): Promise<void> {
  if (!sharedPool) {
    return;
  }

  const pool = sharedPool;
  sharedPool = undefined;
  await pool.end();
}
