const express = require('express');
const { z }   = require('zod');
const bcrypt  = require('bcrypt');
const { pool, withTransaction }    = require('../config/db');
const asyncHandler                 = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate                     = require('../middleware/validate');
const { unauthorized, notFound }   = require('../utils/errors');

const router = express.Router();

// ── GET /api/admin/reset/preview ─────────────────────────────────────────────
// Returns the counts of what would be deleted if a reset were performed now.
// Used by the confirmation modal so the admin knows exactly what they're
// about to wipe.
router.get(
  '/reset/preview',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const [movements, usage, stock, openDisputes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM stock_movements'),
      pool.query('SELECT COUNT(*)::int AS n FROM tool_usage'),
      pool.query('SELECT COUNT(*)::int AS n FROM facility_stock'),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM stock_movements
         WHERE ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL`
      ),
    ]);

    res.json({
      data: {
        stock_movements: movements.rows[0].n,
        tool_usage:      usage.rows[0].n,
        facility_stock:  stock.rows[0].n,
        open_disputes:   openDisputes.rows[0].n,
      },
    });
  })
);

// ── POST /api/admin/reset ────────────────────────────────────────────────────
// Wipes all operational data:
//   - stock_movements (every receipt, transfer, adjustment, dispute)
//   - tool_usage      (every daily usage entry)
//   - facility_stock  (all on-hand balances)
//
// Preserved: users (including last_login_at), facilities, LGAs, states,
// tools, thematic areas, tool_thresholds.
//
// Two-step confirmation required:
//   - Body must include {confirmation: "RESET"}
//   - Body must include the current admin's password (verified against the
//     bcrypt hash on their account).
const resetSchema = z.object({
  confirmation: z.literal('RESET', { errorMap: () => ({ message: 'Type RESET (exact, all caps) to confirm.' }) }),
  password:     z.string().min(1, 'Password is required'),
});

router.post(
  '/reset',
  requireAuth,
  requireRole('admin'),
  validate(resetSchema),
  asyncHandler(async (req, res) => {
    // 1. Verify the requesting admin's password against their bcrypt hash.
    //    Stops accidental clicks and prevents a stolen-session reset.
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userResult.rows.length === 0) throw notFound('User not found');

    const passwordOk = await bcrypt.compare(req.body.password, userResult.rows[0].password_hash);
    if (!passwordOk) throw unauthorized('Incorrect password');

    // 2. Snapshot counts before the wipe so we can report what was cleared.
    const snapshot = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stock_movements)::int AS movements,
        (SELECT COUNT(*) FROM tool_usage)::int      AS usage,
        (SELECT COUNT(*) FROM facility_stock)::int  AS stock
    `);
    const counts = snapshot.rows[0];

    // 3. TRUNCATE in a single statement — bypasses per-row FK checks and
    //    resets the SERIAL sequences so new IDs start fresh from 1.
    await withTransaction(async (client) => {
      await client.query(
        'TRUNCATE tool_usage, stock_movements, facility_stock RESTART IDENTITY'
      );
    });

    // 4. Server-side audit trace. Supabase log capture preserves this.
    console.warn(
      `[admin reset] performed by ${req.user.username} (id ${req.user.id}) — ` +
      `cleared ${counts.movements} movements, ${counts.usage} usage, ${counts.stock} stock`
    );

    res.json({
      message: 'Operational data has been reset',
      cleared: {
        stock_movements: counts.movements,
        tool_usage:      counts.usage,
        facility_stock:  counts.stock,
      },
    });
  })
);

module.exports = router;
