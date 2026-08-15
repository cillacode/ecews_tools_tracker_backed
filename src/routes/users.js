const express = require('express');
const bcrypt  = require('bcrypt');
const { z }   = require('zod');
const { pool }        = require('../config/db');
const asyncHandler    = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate        = require('../middleware/validate');
const { notFound, badRequest, forbidden } = require('../utils/errors');

const router = express.Router();

const SALT_ROUNDS = 12;
const ROLES = ['super_admin', 'admin', 'central_logistics', 'facility_user', 'viewer', 'dso'];

function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

// Validate that the scope fields match the role's required shape (mirrors the
// users_scope_check DB constraint, but with friendlier error messages).
function assertScopeShape(role, { facility_id, lga_id, state_id }) {
  switch (role) {
    case 'super_admin':
      if (facility_id || lga_id || state_id) throw badRequest('A super admin must have no state, LGA, or facility.');
      break;
    case 'admin':
    case 'central_logistics':
      if (!state_id) throw badRequest(`A ${role.replace('_', ' ')} must be assigned to a state.`);
      if (facility_id || lga_id) throw badRequest('Only a state may be set for this role.');
      break;
    case 'viewer':
      if (facility_id || lga_id) throw badRequest('A viewer cannot have a facility or LGA.');
      // state_id optional: set = state viewer, null = HQ viewer.
      break;
    case 'facility_user':
      if (!facility_id) throw badRequest('A facility user must be assigned to a facility.');
      if (lga_id || state_id) throw badRequest('Only a facility may be set for a facility user.');
      break;
    case 'dso':
      if (!lga_id) throw badRequest('A DSO must be assigned to an LGA.');
      if (facility_id || state_id) throw badRequest('Only an LGA may be set for a DSO.');
      break;
    default:
      throw badRequest('Unknown role');
  }
}

// Resolve the effective state a target user will belong to, given their role
// and scope fields. Used to enforce state-admin boundaries.
async function resolveTargetState(role, { facility_id, lga_id, state_id }) {
  if (role === 'facility_user') {
    const r = await pool.query(
      'SELECT l.state_id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE f.id = $1',
      [facility_id]
    );
    if (r.rows.length === 0) throw badRequest('Facility not found');
    return r.rows[0].state_id;
  }
  if (role === 'dso') {
    const r = await pool.query('SELECT state_id FROM lgas WHERE id = $1', [lga_id]);
    if (r.rows.length === 0) throw badRequest('LGA not found');
    return r.rows[0].state_id;
  }
  return state_id ?? null; // admin/central/viewer (or super_admin → null)
}

// Authorize the acting user to create/modify a target with the given role/scope.
//   super_admin → unrestricted
//   state admin → may only manage users within their own state, and may not
//                 create super_admins or HQ (stateless) viewers.
async function assertActorCanManage(actor, role, scope) {
  if (actor.role === 'super_admin') return;

  // Beyond here, the actor is a state-bound admin.
  if (role === 'super_admin') {
    throw forbidden('Only a super admin can manage super admins.');
  }
  if (role === 'viewer' && !scope.state_id) {
    throw forbidden('Only a super admin can create HQ (all-state) viewers.');
  }
  const targetState = await resolveTargetState(role, scope);
  if (targetState !== actor.effective_state_id) {
    throw forbidden('You can only manage users within your own state.');
  }
}

// ── GET /api/users ────────────────────────────────────────────────────────────
// super_admin → all users. State admin → users whose effective state is theirs.
router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const params = [];
    let scopeWhere = '';
    if (req.user.role === 'super_admin') {
      // HQ manages the state admins only. Facility users / DSOs / viewers /
      // central are managed by their own state admin.
      scopeWhere = `WHERE u.role = 'admin'`;
    } else if (req.user.effective_state_id) {
      params.push(req.user.effective_state_id);
      // A user belongs to the actor's state if their own state, their
      // facility's state, or their LGA's state matches. super_admins (NULL on
      // all three) are hidden from state admins.
      scopeWhere = `WHERE COALESCE(u.state_id, fl.state_id, ul.state_id) = $1`;
    }

    const result = await pool.query(
      `SELECT
         u.id, u.username, u.email, u.full_name, u.role,
         u.facility_id, u.lga_id, u.state_id, u.is_active,
         u.last_login_at, u.created_at, u.updated_at,
         f.name AS facility_name,
         COALESCE(fl.name, ul.name) AS lga_name,
         COALESCE(os.name, fs.name, us.name) AS state_name
       FROM users u
       LEFT JOIN facilities f  ON f.id  = u.facility_id
       LEFT JOIN lgas       fl ON fl.id = f.lga_id
       LEFT JOIN lgas       ul ON ul.id = u.lga_id
       LEFT JOIN states     os ON os.id = u.state_id
       LEFT JOIN states     fs ON fs.id = fl.state_id
       LEFT JOIN states     us ON us.id = ul.state_id
       ${scopeWhere}
       ORDER BY u.full_name`,
      params
    );
    res.json({ data: result.rows.map(publicUser) });
  })
);

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT u.*, f.name AS facility_name
       FROM users u LEFT JOIN facilities f ON f.id = u.facility_id
       WHERE u.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) throw notFound('User not found');
    res.json({ data: publicUser(result.rows[0]) });
  })
);

// ── POST /api/users (admin / super_admin) ─────────────────────────────────────
const createUserSchema = z.object({
  username:    z.string().trim().min(3, 'Username must be at least 3 characters'),
  email:       z.string().email('Valid email required'),
  full_name:   z.string().trim().min(1, 'Full name is required'),
  password:    z.string().min(8, 'Password must be at least 8 characters'),
  role:        z.enum(ROLES),
  facility_id: z.number().int().positive().optional(),
  lga_id:      z.number().int().positive().optional(),
  state_id:    z.number().int().positive().optional(),
});

router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const { username, email, full_name, password, role, facility_id, lga_id, state_id } = req.body;
    const scope = { facility_id, lga_id, state_id };

    assertScopeShape(role, scope);
    await assertActorCanManage(req.user, role, scope);

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (username, email, full_name, password_hash, role, facility_id, lga_id, state_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [username, email, full_name, password_hash, role,
       facility_id ?? null, lga_id ?? null, state_id ?? null]
    );

    res.status(201).json({ data: publicUser(result.rows[0]) });
  })
);

// ── PATCH /api/users/:id (admin / super_admin) ────────────────────────────────
const updateUserSchema = z.object({
  full_name:   z.string().trim().min(1).optional(),
  email:       z.string().email().optional(),
  role:        z.enum(ROLES).optional(),
  facility_id: z.number().int().positive().nullable().optional(),
  lga_id:      z.number().int().positive().nullable().optional(),
  state_id:    z.number().int().positive().nullable().optional(),
  is_active:   z.boolean().optional(),
  password:    z.string().min(8).optional(),
});

router.patch(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw notFound('User not found');
    const current = existing.rows[0];

    const newRole       = req.body.role        ?? current.role;
    const newFacilityId = req.body.facility_id !== undefined ? req.body.facility_id : current.facility_id;
    const newLgaId      = req.body.lga_id      !== undefined ? req.body.lga_id      : current.lga_id;
    const newStateId    = req.body.state_id    !== undefined ? req.body.state_id    : current.state_id;
    const scope = { facility_id: newFacilityId, lga_id: newLgaId, state_id: newStateId };

    assertScopeShape(newRole, scope);
    // A state admin must be allowed to manage BOTH the existing and the new
    // shape (so they can't move a user out of their state or grab someone else's).
    await assertActorCanManage(req.user, current.role, {
      facility_id: current.facility_id, lga_id: current.lga_id, state_id: current.state_id,
    });
    await assertActorCanManage(req.user, newRole, scope);

    const ALLOWED = ['full_name', 'email', 'role', 'facility_id', 'lga_id', 'state_id', 'is_active'];
    const fields = [];
    const params = [];
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }
    if (req.body.password) {
      const hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
      params.push(hash);
      fields.push(`password_hash = $${params.length}`);
    }
    if (fields.length === 0) return res.json({ data: publicUser(current) });

    params.push(id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ data: publicUser(result.rows[0]) });
  })
);

module.exports = router;
