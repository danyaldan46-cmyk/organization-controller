const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Runs `fn` inside a transaction with Postgres session variables set for
 * Row Level Security. This is the ONLY sanctioned way route handlers should
 * touch the database — it guarantees every query in `fn` is scoped to the
 * requester's organization, and RLS policies will reject anything that
 * isn't, even if a query forgets its own WHERE clause.
 *
 * @param {{ orgId: string }} ctx
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function withTenant(ctx, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org_id', ctx.orgId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTenant };
