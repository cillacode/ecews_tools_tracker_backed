// Lightweight migration runner.
// Reads .sql files from src/db/migrations/ in alphabetical order.
// Tracks completed migrations in a _migrations table so re-runs are safe.
//
// Usage: npm run db:migrate

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getApplied(client) {
  const res = await client.query('SELECT filename FROM _migrations');
  return new Set(res.rows.map((r) => r.filename));
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);
    const applied = await getApplied(client);
    const files = listMigrationFiles();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`✓ skip   ${file}  (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→ apply  ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✓ done   ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✖ fail   ${file}`);
        throw err;
      }
    }

    console.log(
      appliedCount === 0
        ? '\nNothing to do — all migrations are up to date.'
        : `\nApplied ${appliedCount} migration(s).`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
