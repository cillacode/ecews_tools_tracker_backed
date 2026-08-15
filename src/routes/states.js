const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/states/summary ───────────────────────────────────────────────────
// Per-state facility + LGA counts for the HQ "States" drill-down. HQ only.
router.get(
  '/summary',
  requireAuth,
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         s.id,
         s.name,
         COUNT(DISTINCT l.id)::int                              AS lga_count,
         COUNT(f.id) FILTER (WHERE f.is_active = TRUE)::int     AS facility_count
       FROM states s
       LEFT JOIN lgas       l ON l.state_id = s.id
       LEFT JOIN facilities f ON f.lga_id   = l.id
       GROUP BY s.id, s.name
       ORDER BY s.name`
    );
    res.json({ data: result.rows });
  })
);

// ── GET /api/states ───────────────────────────────────────────────────────────
// super_admin / HQ viewer → all states.
// Any state-bound user → only their own state (so pickers can't reach across).
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = [];
    let where = '';
    if (req.user.role !== 'super_admin' && req.user.effective_state_id) {
      params.push(req.user.effective_state_id);
      where = 'WHERE id = $1';
    }
    const result = await pool.query(
      `SELECT id, name FROM states ${where} ORDER BY name`,
      params
    );
    res.json({ data: result.rows });
  })
);

module.exports = router;
