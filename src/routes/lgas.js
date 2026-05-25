const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/lgas?state_id=
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { state_id } = req.query;
    const params = [];
    let where = '';

    if (state_id) {
      params.push(Number(state_id));
      where = 'WHERE l.state_id = $1';
    }

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
