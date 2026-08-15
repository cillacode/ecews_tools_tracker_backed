const { Pool, types } = require('pg');
const env = require('./env');

// Return DATE columns (usage_date, week buckets…) as plain 'YYYY-MM-DD'
// strings instead of JS Date objects. The default Date parsing lands at
// LOCAL midnight, so any toISOString()/JSON serialization in a non-UTC
// timezone (we run in UTC+1) silently shifts dates back by one day.
types.setTypeParser(1082, (v) => v);

// Single shared pool. SSL flag supports both local Postgres and managed (Supabase / RDS).
const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.dbSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

// Convenience helper for transactional work.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

module.exports = { pool, withTransaction };
