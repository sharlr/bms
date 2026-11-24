import pg from 'pg';

// Numeric & bigint as JS numbers (ids stay far below 2^53; money rounded to 2dp in app).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => parseInt(v, 10));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export async function many<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await db.query(sql, params as any[]);
  return r.rows[0] as T | undefined;
}

export async function exec(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query(sql, params as any[]);
  return r.rowCount ?? 0;
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Quote an SQL identifier. Only ever used with values already validated against a strict regex. */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('unsafe identifier');
  return `"${name}"`;
}

export async function nextSeq(c: Queryable, branchId: number, name: string): Promise<number> {
  const r = await one<{ last_value: number }>(
    c,
    `INSERT INTO branch_sequences (branch_id, seq_name, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (branch_id, seq_name) DO UPDATE SET last_value = branch_sequences.last_value + 1
     RETURNING last_value`,
    [branchId, name],
  );
  return r!.last_value;
}
