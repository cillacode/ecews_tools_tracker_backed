const express = require('express');
const { z }   = require('zod');
const { pool }     = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate     = require('../middleware/validate');
const { notFound } = require('../utils/errors');

const router = express.Router();

// ── GET /api/thresholds ───────────────────────────────────────────────────────
// Returns all thresholds with joins, with current stock quantity for context.
router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         tt.id, tt.min_quantity, tt.created_at, tt.updated_at,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         f.id   AS facility_id,
         f.name AS facility_name,
         fs.quantity AS current_quantity
       FROM tool_thresholds tt
       JOIN tools          t  ON t.id  = tt.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN facilities f  ON f.id  = tt.facility_id
       LEFT JOIN facility_stock fs
              ON fs.tool_id = tt.tool_id
             AND fs.facility_id = tt.facility_id
       ORDER BY t.name, f.name NULLS FIRST`
    );
    res.json({ data: result.rows });
  })
);

// ── POST /api/thresholds (admin only) ─────────────────────────────────────────
// facility_id = null → global default for the tool.
const createSchema = z.object({
  tool_id:      z.number().int().positive('Tool is required'),
  facility_id:  z.number().int().positive().nullable().optional(),
  min_quantity: z.number().int().min(0, 'Minimum quantity must be 0 or more'),
});

router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { tool_id, facility_id, min_quantity } = req.body;

    // Upsert: if a threshold already exists for this (tool, facility) pair, update it.
    const result = await pool.query(
      `INSERT INTO tool_thresholds (tool_id, facility_id, min_quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uniq_tool_thresholds_global
         DO UPDATE SET min_quantity = EXCLUDED.min_quantity, updated_at = NOW()
       RETURNING *`,
      [tool_id, facility_id ?? null, min_quantity]
    );

    res.status(201).json({ data: result.rows[0] });
  })
);

// ── DELETE /api/thresholds/:id (admin only) ───────────────────────────────────
router.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      'DELETE FROM tool_thresholds WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) throw notFound('Threshold not found');
    res.json({ message: 'Threshold removed' });
  })
);

module.exports = router;
