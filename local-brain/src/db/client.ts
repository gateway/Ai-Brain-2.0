import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { readConfig } from "../config.js";

let sharedPool: Pool | undefined;
const MAINTENANCE_LOCK_KEY_A = 88421;
const MAINTENANCE_LOCK_KEY_B = 200;
const MAINTENANCE_LOCK_WAIT_MS = 30_000;
const MAINTENANCE_LOCK_POLL_MS = 500;
let localMaintenanceDepth = 0;

type QueryableClient = Pick<PoolClient, "query">;

export function getPool(): Pool {
  if (!sharedPool) {
    const config = readConfig();
    const requestedMax = Number(process.env.BRAIN_PG_POOL_MAX ?? "");
    const max = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : undefined;
    sharedPool = new Pool({
      connectionString: config.databaseUrl,
      ...(max ? { max } : {})
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

async function tryAcquireLock(client: QueryableClient, keyA: number, keyB: number): Promise<boolean> {
  const result = await client.query<{ readonly acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS acquired",
    [keyA, keyB]
  );
  return result.rows[0]?.acquired === true;
}

async function releaseLock(client: QueryableClient, keyA: number, keyB: number): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

  const config = readConfig();
  const client = new Client({
    connectionString: config.databaseUrl
  });
  await client.connect();
  const deadline = Date.now() + MAINTENANCE_LOCK_WAIT_MS;
  let acquired = await tryAcquireLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);

  while (!acquired && Date.now() < deadline) {
    await sleep(MAINTENANCE_LOCK_POLL_MS);
    acquired = await tryAcquireLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
  }

  if (!acquired) {
    await client.end();
    throw new Error(
      `Maintenance mode is already active. Wait for the current job to finish before starting ${reason}. Timed out after ${MAINTENANCE_LOCK_WAIT_MS}ms.`
    );
  }

  try {
    localMaintenanceDepth += 1;
    return await fn();
  } catch (error) {
    try {
      localMaintenanceDepth = Math.max(0, localMaintenanceDepth - 1);
      await releaseLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
    } catch {
      // Preserve the original benchmark/runtime failure.
    } finally {
      await client.end();
    }
    throw error;
  } finally {
    if (localMaintenanceDepth > 0) {
      try {
        localMaintenanceDepth = Math.max(0, localMaintenanceDepth - 1);
        await releaseLock(client, MAINTENANCE_LOCK_KEY_A, MAINTENANCE_LOCK_KEY_B);
      } finally {
        await client.end();
      }
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
