const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/service-points ───────────────────────────────────────────────────
// Active service delivery points for the usage-entry dropdown. DB-driven so the
// list grows without a code change.
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name FROM service_points WHERE is_active = TRUE ORDER BY sort_order, name`
    );
    res.json({ data: result.rows });
  })
);

module.exports = router;
