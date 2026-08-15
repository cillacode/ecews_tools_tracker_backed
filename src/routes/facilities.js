const express = require('express');
const { z } = require('zod');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { applyStateScope, assertCanAccessFacility } = require('../middleware/scope');

const router = express.Router();

// ── GET /api/facilities ───────────────────────────────────────────────────────
// Supports ?lga_id, ?q (name search), ?page, ?limit
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { lga_id, state_id, q, page = 1, limit = 200 } = req.query;

    const conditions = ['f.is_active = TRUE'];
    const params = [];

    // Directory scoping:
    //   super_admin / HQ viewer → all states (may filter by ?lga_id)
    //   dso                     → their LGA only
    //   everyone else           → their STATE (not narrower) so within-state
    //                              transfer destination pickers still work for
    //                              facility users. Cross-state is forbidden.
    if (req.user.role === 'dso') {
      if (!req.user.lga_id) throw badRequest('DSO has no LGA assigned');
      params.push(req.user.lga_id);
      conditions.push(`f.lga_id = $${params.length}`);
    } else {
      // Adds `l.state_id = $n` for state-bound roles; no-op for super/HQ viewer.
      applyStateScope(req, conditions, params, 'l.state_id');
      // super_admin / HQ viewer may narrow to one state (state-bound roles are
      // already constrained above, so this is only meaningful for them).
      if (state_id && (req.user.role === 'super_admin' || !req.user.effective_state_id)) {
        params.push(Number(state_id));
        conditions.push(`l.state_id = $${params.length}`);
      }
      if (lga_id) {
        params.push(Number(lga_id));
        conditions.push(`f.lga_id = $${params.length}`);
      }
    }

    if (q) {
      params.push(`%${q.trim()}%`);
      conditions.push(`f.name ILIKE $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // NB: must join lgas here too — the WHERE can reference l.state_id.
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM facilities f JOIN lgas l ON l.id = f.lga_id ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
    params.push(Number(limit), offset);

    const result = await pool.query(
      `SELECT
         f.id, f.name, f.code, f.is_active, f.created_at, f.updated_at,
         l.id   AS lga_id,
         l.name AS lga_name,
         s.id   AS state_id,
         s.name AS state_name
       FROM facilities f
       JOIN lgas   l ON l.id = f.lga_id
       JOIN states s ON s.id = l.state_id
       ${where}
       ORDER BY l.name, f.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

// ── GET /api/facilities/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         f.id, f.name, f.code, f.is_active, f.created_at, f.updated_at,
         l.id   AS lga_id,
         l.name AS lga_name,
         s.id   AS state_id,
         s.name AS state_name
       FROM facilities f
       JOIN lgas   l ON l.id = f.lga_id
       JOIN states s ON s.id = l.state_id
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) throw notFound('Facility not found');

    const facility = result.rows[0];
    assertCanAccessFacility(req, forbidden, facility);

    res.json({ data: facility });
  })
);

// ── GET /api/facilities/:id/stock ─────────────────────────────────────────────
// Per-facility stock: all tools this facility has ever had movement for,
// grouped by thematic area, ordered by thematic area sort order then tool name.
router.get(
  '/:id/stock',
  requireAuth,
  asyncHandler(async (req, res) => {
    const facilityResult = await pool.query(
      `SELECT f.id, f.name, f.lga_id, l.state_id
       FROM facilities f JOIN lgas l ON l.id = f.lga_id
       WHERE f.id = $1 AND f.is_active = TRUE`,
      [req.params.id]
    );
    if (facilityResult.rows.length === 0) throw notFound('Facility not found');

    const facility = facilityResult.rows[0];
    assertCanAccessFacility(req, forbidden, facility);

    const stockResult = await pool.query(
      `SELECT
         fs.tool_id,
         fs.quantity,
         fs.last_movement_at,
         t.name               AS tool_name,
         t.status             AS tool_status,
         t.is_new_indicator,
         t.is_ip_retained,
         ta.id                AS thematic_area_id,
         ta.name              AS thematic_area_name,
         ta.code              AS thematic_area_code,
         ta.sort_order
       FROM facility_stock fs
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE fs.facility_id = $1
       ORDER BY ta.sort_order, t.name`,
      [req.params.id]
    );

    res.json({
      facility: facilityResult.rows[0],
      data: stockResult.rows,
    });
  })
);

// ── POST /api/facilities (admin only) ────────────────────────────────────────
const createFacilitySchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  lga_id: z.number().int().positive('LGA is required'),
  code: z.string().trim().optional(),
});

router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate(createFacilitySchema),
  asyncHandler(async (req, res) => {
    const { name, lga_id, code } = req.body;

    const result = await pool.query(
      `INSERT INTO facilities (name, lga_id, code)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, lga_id, code ?? null]
    );

    res.status(201).json({ data: result.rows[0] });
  })
);

// ── PATCH /api/facilities/:id (admin only) ────────────────────────────────────
const updateFacilitySchema = z.object({
  name: z.string().trim().min(1).optional(),
  lga_id: z.number().int().positive().optional(),
  code: z.string().trim().optional(),
  is_active: z.boolean().optional(),
});

router.patch(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validate(updateFacilitySchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await pool.query('SELECT id FROM facilities WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw notFound('Facility not found');

    const ALLOWED = ['name', 'lga_id', 'code', 'is_active'];
    const fields = [];
    const params = [];

    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }

    if (fields.length === 0) {
      return res.json({ data: existing.rows[0] });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE facilities
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    res.json({ data: result.rows[0] });
  })
);

module.exports = router;
