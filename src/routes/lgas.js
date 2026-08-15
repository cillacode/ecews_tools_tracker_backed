const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/lgas?state_id=
// State-bound users only ever see LGAs in their own state, regardless of the
// state_id query param. super_admin / HQ viewer may filter freely.
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.user.role !== 'super_admin' && req.user.effective_state_id) {
      params.push(req.user.effective_state_id);
      conditions.push(`l.state_id = $${params.length}`);
    } else if (req.query.state_id) {
      params.push(Number(req.query.state_id));
      conditions.push(`l.state_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT l.id, l.name, l.state_id, s.name AS state_name
       FROM lgas l
       JOIN states s ON s.id = l.state_id
       ${where}
       ORDER BY l.name`,
      params
    );

    res.json({ data: result.rows });
  })
);

module.exports = router;
