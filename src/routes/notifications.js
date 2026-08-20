const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { lowToolsForState, DEFAULT_THRESHOLD } = require('./procurement');

const router = express.Router();

// ── GET /api/notifications/summary ────────────────────────────────────────────
// Role-scoped counts that power the sidebar badges:
//   incoming  — items awaiting the user's acknowledgement
//   low_tools — tools at/below the re-order level (state admin only)
// Zeros for roles that have nothing actionable here.
router.get(
  '/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { role } = req.user;
    let incoming = 0;
    let low_tools = 0;

    if (role === 'facility_user' && req.user.facility_id) {
      // Deliveries / transfers awaiting this facility's confirmation.
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM stock_movements
         WHERE movement_type IN ('RECEIPT', 'TRANSFER_IN')
           AND ack_status = 'PENDING_ACK'
           AND facility_id = $1`,
        [req.user.facility_id]
      );
      incoming = r.rows[0].n;
    } else if (role === 'admin' && req.user.effective_state_id) {
      const stateId = req.user.effective_state_id;
      // HQ shipments awaiting the state admin's acceptance.
      const inc = await pool.query(
        `SELECT COUNT(*)::int AS n FROM state_movements
         WHERE ack_status = 'PENDING_ACK' AND state_id = $1`,
        [stateId]
      );
      incoming = inc.rows[0].n;
      // Tools at/below the standard re-order level.
      const low = await lowToolsForState(stateId, DEFAULT_THRESHOLD);
      low_tools = low.length;
    }

    res.json({ data: { incoming, low_tools } });
  })
);

module.exports = router;
