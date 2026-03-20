import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readConfig } from "../config.js";

let sharedPool: Pool | undefined;
const MAINTENANCE_LOCK_KEY_A = 88421;
const MAINTENANCE_LOCK_KEY_B = 200;
let localMaintenanceDepth = 0;

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

async function tryAcquireLock(client: PoolClient, keyA: number, keyB: number): Promise<boolean> {
  const result = await client.query<{ readonly acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [keyA, keyB]
  );
  return result.rows[0]?.acquired === true;
}

async function releaseLock(client: PoolClient, keyA: number, keyB: number): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
}

export async function isMaintenanceLockActive(): Promise<boolean> {
  return withClient(async (client) => {
    const acquired = await tryAcquireLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
    if (acquired) {
      await releaseLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
      return false;
    }
    return true;
  });
}

export async function withMaintenanceLock<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (localMaintenanceDepth > 0) {
    localMaintenanceDepth += 1;
    try {
      return await fn();
    } finally {
      localMaintenanceDepth = Math.max(0, localMaintenanceDepth - 1);
    }
  }

  const client = await getPool().connect();
  const acquired = await tryAcquireLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);

  if (!acquired) {
    client.release();
    throw new Error(`Maintenance mode is already active. Wait for the current job to finish before starting ${reason}.`);
  }

  try {
    localMaintenanceDepth += 1;
    return await fn();
  } finally {
    try {
      localMaintenanceDepth = Math.max(0, localMaintenanceDepth - 1);
      await releaseLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
    } finally {
      client.release();
    }
  }
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
