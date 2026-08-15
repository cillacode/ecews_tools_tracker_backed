const express = require('express');
const { z } = require('zod');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { notFound } = require('../utils/errors');

const router = express.Router();

// ── GET /api/tools ────────────────────────────────────────────────────────────
// Supports ?thematic_area_id, ?status, ?q (name search), ?page, ?limit
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { thematic_area_id, status, q, page = 1, limit = 200 } = req.query;

    const conditions = ['t.is_active = TRUE'];
    const params = [];

    if (thematic_area_id) {
      params.push(Number(thematic_area_id));
      conditions.push(`t.thematic_area_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.trim()}%`);
      conditions.push(`t.name ILIKE $${params.length}`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM tools t ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
    params.push(Number(limit), offset);

    const result = await pool.query(
      `SELECT
         t.id, t.name, t.status, t.is_new_indicator, t.is_ip_retained,
         t.description, t.is_active, t.created_at, t.updated_at,
         ta.id   AS thematic_area_id,
         ta.name AS thematic_area_name,
         ta.code AS thematic_area_code,
         ta.sort_order
       FROM tools t
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       ${where}
       ORDER BY ta.sort_order, t.name
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

// ── GET /api/tools/:id ────────────────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         t.id, t.name, t.status, t.is_new_indicator, t.is_ip_retained,
         t.description, t.is_active, t.created_at, t.updated_at,
         ta.id   AS thematic_area_id,
         ta.name AS thematic_area_name,
         ta.code AS thematic_area_code
       FROM tools t
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) throw notFound('Tool not found');
    res.json({ data: result.rows[0] });
  })
);

// ── GET /api/tools/:id/distribution ───────────────────────────────────────────
// Every facility holding this tool, with quantities. State admins are locked to
// their own state; super_admin (HQ) sees all states and may optionally narrow
// with ?state_id (the tools-catalogue drill-down filters by state then LGA).
router.get(
  '/:id/distribution',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const toolId = parseInt(req.params.id, 10);
    if (!Number.isInteger(toolId)) throw notFound('Tool not found');

    let stateId;
    if (req.user.role === 'super_admin') {
      const q = parseInt(req.query.state_id, 10);
      stateId = Number.isInteger(q) ? q : null; // null = every state
    } else {
      stateId = req.user.effective_state_id ?? null;
    }

    const result = await pool.query(
      `SELECT
         f.id   AS facility_id,
         f.name AS facility_name,
         l.name AS lga_name,
         s.name AS state_name,
         fs.quantity,
         fs.last_movement_at
       FROM facility_stock fs
       JOIN facilities f ON f.id = fs.facility_id
       JOIN lgas       l ON l.id = f.lga_id
       JOIN states     s ON s.id = l.state_id
       WHERE fs.tool_id = $1
         AND f.is_active = TRUE
         AND ($2::int IS NULL OR l.state_id = $2)
       ORDER BY fs.quantity DESC, f.name`,
      [toolId, stateId]
    );

    const total = result.rows.reduce((sum, r) => sum + r.quantity, 0);
    res.json({ total, count: result.rows.length, data: result.rows });
  })
);

// ── POST /api/tools (admin only) ──────────────────────────────────────────────
const createToolSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  thematic_area_id: z.number().int().positive('Thematic area is required'),
  status: z.enum(['NEW_MODIFIED', 'RETAINED']),
  is_new_indicator: z.boolean().default(false),
  is_ip_retained: z.boolean().default(false),
  description: z.string().trim().optional(),
});

router.post(
  '/',
  requireAuth,
  requireRole('super_admin'),
  validate(createToolSchema),
  asyncHandler(async (req, res) => {
    const { name, thematic_area_id, status, is_new_indicator, is_ip_retained, description } =
      req.body;

    const result = await pool.query(
      `INSERT INTO tools
         (name, thematic_area_id, status, is_new_indicator, is_ip_retained, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, thematic_area_id, status, is_new_indicator, is_ip_retained, description ?? null]
    );

    res.status(201).json({ data: result.rows[0] });
  })
);

// ── PATCH /api/tools/:id (admin only) ────────────────────────────────────────
const updateToolSchema = z.object({
  name: z.string().trim().min(1).optional(),
  thematic_area_id: z.number().int().positive().optional(),
  status: z.enum(['NEW_MODIFIED', 'RETAINED']).optional(),
  is_new_indicator: z.boolean().optional(),
  is_ip_retained: z.boolean().optional(),
  description: z.string().trim().optional(),
  is_active: z.boolean().optional(),
});

router.patch(
  '/:id',
  requireAuth,
  requireRole('super_admin'),
  validate(updateToolSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await pool.query('SELECT id FROM tools WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw notFound('Tool not found');

    const ALLOWED = [
      'name', 'thematic_area_id', 'status',
      'is_new_indicator', 'is_ip_retained', 'description', 'is_active',
    ];
    const fields = [];
    const params = [];

    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        fields.push(`${key} = $${params.length}`);
      }
    }

    if (fields.length === 0) {
      // Nothing to update — return current row with thematic area joined
      const full = await pool.query(
        `SELECT t.*, ta.name AS thematic_area_name FROM tools t
         JOIN thematic_areas ta ON ta.id = t.thematic_area_id WHERE t.id = $1`,
        [id]
      );
      return res.json({ data: full.rows[0] });
    }

    params.push(id);
    const result = await pool.query(
      `UPDATE tools
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    res.json({ data: result.rows[0] });
  })
);

module.exports = router;
