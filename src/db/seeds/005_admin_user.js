// Creates a default admin user from .env values (DEFAULT_ADMIN_*).
// Idempotent — does nothing if a user with the same username already exists.
// IMPORTANT: change the default password immediately after first login.

const bcrypt = require('bcrypt');
const { pool } = require('../../config/db');
const env = require('../../config/env');

async function seed() {
  const { username, email, password, name } = env.defaultAdmin;
  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);

  if (existing.rows.length > 0) {
    console.log(`✓ skip   default admin (already exists: ${username})`);
    return;
  }

  const hash = await bcrypt.hash(password, env.bcryptCost);
  await pool.query(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES ($1, $2, $3, $4, 'admin', TRUE)`,
    [username, email, hash, name]
  );

  console.log(`✓ created default admin: ${username} / ${email}`);
  console.log(`  ⚠ Change the password (current: ${password}) after first login.`);
}

module.exports = seed;
