const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/thematic-areas
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, code, sort_order FROM thematic_areas ORDER BY sort_order, name`
    );
    res.json({ data: result.rows });
  })
);

module.exports = router;
