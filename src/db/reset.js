// Drops the entire public schema and recreates it. DEV ONLY.
// Refuses to run with NODE_ENV=production.

const { pool } = require('../config/db');
const env = require('../config/env');

async function reset() {
  if (env.isProd) {
    console.error('✖ refusing to reset DB in production');
    process.exit(1);
  }

  console.log('⚠ Dropping and recreating public schema...');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await pool.query('CREATE SCHEMA public;');
  console.log('✓ Schema reset. Run db:migrate next.');
}

reset()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
