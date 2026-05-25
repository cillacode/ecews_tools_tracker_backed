const express = require('express');
const bcrypt  = require('bcrypt');
const { z }   = require('zod');
const { pool }        = require('../config/db');
const asyncHandler    = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate        = require('../middleware/validate');
const { notFound, badRequest } = require('../utils/errors');

const router = express.Router();

const SALT_ROUNDS = 12;

function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

// ── GET /api/users ────────────────────────────────────────────────────────────
router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         u.id, u.username, u.email, u.full_name, u.role,
         u.facility_id, u.lga_id, u.is_active, u.last_login_at, u.created_at, u.updated_at,
         f.name AS facility_name,
         COALESCE(fl.name, ul.name) AS lga_name
       FROM users u
       LEFT JOIN facilities f  ON f.id  = u.facility_id
       LEFT JOIN lgas       fl ON fl.id = f.lga_id
       LEFT JOIN lgas       ul ON ul.id = u.lga_id
       ORDER BY u.full_name`
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

// ── POST /api/users (admin only) ──────────────────────────────────────────────
const createUserSchema = z.object({
  username:    z.string().trim().min(3, 'Username must be at least 3 characters'),
  email:       z.string().email('Valid email required'),
  full_name:   z.string().trim().min(1, 'Full name is required'),
  password:    z.string().min(8, 'Password must be at least 8 characters'),
  role:        z.enum(['admin', 'central_logistics', 'facility_user', 'viewer', 'dso']),
  facility_id: z.number().int().positive().optional(),
  lga_id:      z.number().int().positive().optional(),
});

router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const { username, email, full_name, password, role, facility_id, lga_id } = req.body;

    if (role === 'facility_user') {
      if (!facility_id) throw badRequest('facility_id is required for facility_user role');
      if (lga_id) throw badRequest('lga_id must be empty for facility_user role');
    } else if (role === 'dso') {
      if (!lga_id) throw badRequest('lga_id is required for DSO role');
      if (facility_id) throw badRequest('facility_id must be empty for DSO role');
    } else {
      if (facility_id) throw badRequest('facility_id must be empty for this role');
      if (lga_id) throw badRequest('lga_id must be empty for this role');
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (username, email, full_name, password_hash, role, facility_id, lga_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [username, email, full_name, password_hash, role, facility_id ?? null, lga_id ?? null]
    );

    res.status(201).json({ data: publicUser(result.rows[0]) });
  })
);

// ── PATCH /api/users/:id (admin only) ────────────────────────────────────────
const updateUserSchema = z.object({
  full_name:   z.string().trim().min(1).optional(),
  email:       z.string().email().optional(),
  role:        z.enum(['admin', 'central_logistics', 'facility_user', 'viewer', 'dso']).optional(),
  facility_id: z.number().int().positive().nullable().optional(),
  lga_id:      z.number().int().positive().nullable().optional(),
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
    const newRole       = req.body.role ?? current.role;
    const newFacilityId = req.body.facility_id !== undefined ? req.body.facility_id : current.facility_id;
    const newLgaId      = req.body.lga_id      !== undefined ? req.body.lga_id      : current.lga_id;

    if (newRole === 'facility_user') {
      if (!newFacilityId) throw badRequest('facility_id is required for facility_user role');
      if (newLgaId)       throw badRequest('lga_id must be empty for facility_user role');
    } else if (newRole === 'dso') {
      if (!newLgaId)      throw badRequest('lga_id is required for DSO role');
      if (newFacilityId)  throw badRequest('facility_id must be empty for DSO role');
    } else {
      if (newFacilityId)  throw badRequest('facility_id must be empty for this role');
      if (newLgaId)       throw badRequest('lga_id must be empty for this role');
    }

    const ALLOWED = ['full_name', 'email', 'role', 'facility_id', 'lga_id', 'is_active'];
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
