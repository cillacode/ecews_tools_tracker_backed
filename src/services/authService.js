const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const { sign } = require('../utils/jwt');
const { unauthorized } = require('../utils/errors');

// Strip the password hash before sending a user back to the client.
function publicUser(row) {
  if (!row) return null;
  // eslint-disable-next-line no-unused-vars
  const { password_hash, ...rest } = row;
  return rest;
}

async function login({ identifier, password }) {
  const result = await pool.query(
    `SELECT u.id, u.username, u.email, u.password_hash, u.full_name, u.role,
            u.facility_id, u.lga_id, u.state_id, u.is_active,
            f.name AS facility_name,
            COALESCE(fl.name, ul.name) AS lga_name,
            -- Effective state: own state_id (admin/central/viewer), or derived
            -- from their facility (facility_user) or their LGA (dso).
            -- super_admin resolves to NULL → sees all states.
            COALESCE(u.state_id, fl.state_id, ul.state_id) AS effective_state_id,
            COALESCE(os.name, fs.name, us.name)            AS state_name
     FROM users u
     LEFT JOIN facilities f  ON f.id  = u.facility_id
     LEFT JOIN lgas       fl ON fl.id = f.lga_id
     LEFT JOIN lgas       ul ON ul.id = u.lga_id
     LEFT JOIN states     os ON os.id = u.state_id
     LEFT JOIN states     fs ON fs.id = fl.state_id
     LEFT JOIN states     us ON us.id = ul.state_id
     WHERE (u.username = $1 OR u.email = $1)`,
    [identifier]
  );

  const user = result.rows[0];
  if (!user || !user.is_active) {
    throw unauthorized('Invalid login credentials');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    throw unauthorized('Invalid login credentials');
  }

  // Update last_login_at — non-blocking; we don't await failure.
  pool
    .query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id])
    .catch((err) => console.warn('failed to update last_login_at:', err.message));

  const token = sign({ sub: user.id, role: user.role });
  return { token, user: publicUser(user) };
}

module.exports = { login, publicUser };
