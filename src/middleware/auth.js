// Auth middleware:
//   - requireAuth          → any logged-in user
//   - requireRole(roles)   → only users whose role is in `roles`
//
// Both attach req.user = { id, role, facility_id } when successful.

const { verify } = require('../utils/jwt');
const { unauthorized, forbidden } = require('../utils/errors');
const { pool } = require('../config/db');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw unauthorized('Missing or malformed Authorization header');
    }

    const payload = verify(token);

    // Re-fetch user to enforce is_active and pick up role changes mid-session.
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.full_name, u.role,
              u.facility_id, u.lga_id, u.is_active,
              f.name AS facility_name,
              COALESCE(fl.name, ul.name) AS lga_name
       FROM users u
       LEFT JOIN facilities f  ON f.id  = u.facility_id
       LEFT JOIN lgas       fl ON fl.id = f.lga_id
       LEFT JOIN lgas       ul ON ul.id = u.lga_id
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      throw unauthorized('User no longer active');
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) return next(forbidden('Insufficient permissions'));
    next();
  };
}

module.exports = { requireAuth, requireRole };
