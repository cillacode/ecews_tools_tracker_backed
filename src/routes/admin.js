const express = require('express');
const { z }   = require('zod');
const bcrypt  = require('bcrypt');
const { pool, withTransaction }         = require('../config/db');
const asyncHandler                      = require('../utils/asyncHandler');
const { requireAuth, requireRole }      = require('../middleware/auth');
const validate                          = require('../middleware/validate');
const { unauthorized, notFound, badRequest } = require('../utils/errors');

const router = express.Router();

// The reset is scoped by who runs it:
//   - super_admin (HQ) → GLOBAL: every tier, every state, a full clean slate.
//   - admin (state)    → their own state only. Lagos's reset never touches
//                        Cross River / Akwa Ibom.
// Returns { isGlobal, stateId, stateName } or throws if a state admin has no
// state context.
async function resolveResetScope(req) {
  if (req.user.role === 'super_admin') {
    return { isGlobal: true, stateId: null, stateName: null };
  }
  const stateId = req.user.effective_state_id;
  if (!stateId) throw badRequest('Your account has no state — cannot scope a reset.');
  const s = await pool.query('SELECT name FROM states WHERE id = $1', [stateId]);
  return { isGlobal: false, stateId, stateName: s.rows[0]?.name ?? null };
}

// Counts of what a reset in this scope would delete. Global uses whole-table
// counts; a state scope filters to that state's facilities + its HQ ledger.
async function resetCounts({ isGlobal, stateId }) {
  if (isGlobal) {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM stock_movements)::int AS movements,
        (SELECT COUNT(*) FROM tool_usage)::int      AS usage,
        (SELECT COUNT(*) FROM facility_stock)::int  AS stock,
        (SELECT COUNT(*) FROM state_movements)::int AS state_movements,
        (SELECT COUNT(*) FROM state_stock)::int     AS state_stock,
        (SELECT COUNT(*) FROM stock_movements
           WHERE ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL)::int AS open_disputes
    `);
    return r.rows[0];
  }
  const r = await pool.query(`
    WITH sf AS (
      SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1
    )
    SELECT
      (SELECT COUNT(*) FROM stock_movements WHERE facility_id IN (SELECT id FROM sf))::int AS movements,
      (SELECT COUNT(*) FROM tool_usage      WHERE facility_id IN (SELECT id FROM sf))::int AS usage,
      (SELECT COUNT(*) FROM facility_stock  WHERE facility_id IN (SELECT id FROM sf))::int AS stock,
      (SELECT COUNT(*) FROM state_movements WHERE state_id = $1)::int AS state_movements,
      (SELECT COUNT(*) FROM state_stock     WHERE state_id = $1)::int AS state_stock,
      (SELECT COUNT(*) FROM stock_movements
         WHERE facility_id IN (SELECT id FROM sf)
           AND ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL)::int AS open_disputes
  `, [stateId]);
  return r.rows[0];
}

// ── GET /api/admin/reset/preview ─────────────────────────────────────────────
// Returns the counts of what would be deleted if a reset were performed now,
// scoped to the caller. Used by the confirmation modal.
router.get(
  '/reset/preview',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const scope  = await resolveResetScope(req);
    const counts = await resetCounts(scope);

    res.json({
      data: {
        is_global:       scope.isGlobal,
        state_name:      scope.stateName,
        stock_movements: counts.movements,
        tool_usage:      counts.usage,
        facility_stock:  counts.stock,
        state_movements: counts.state_movements,
        state_stock:     counts.state_stock,
        open_disputes:   counts.open_disputes,
      },
    });
  })
);

// ── POST /api/admin/reset ────────────────────────────────────────────────────
// Wipes operational data within the caller's scope (see resolveResetScope):
//   - stock_movements (every receipt, transfer, adjustment, dispute)
//   - tool_usage      (every daily usage entry)
//   - facility_stock  (all on-hand balances)
//   - state_movements + state_stock (the HQ→state ledger for that state)
//
// super_admin clears every state; a state admin clears only their own state,
// leaving the other states completely untouched.
//
// Preserved in all cases: users (including last_login_at), facilities, LGAs,
// states, tools, thematic areas, tool_thresholds.
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
    const scope = await resolveResetScope(req);

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
    const counts = await resetCounts(scope);

    // 3. Delete inside a transaction.
    await withTransaction(async (client) => {
      if (scope.isGlobal) {
        // TRUNCATE bypasses per-row FK checks and resets SERIAL sequences so
        // new IDs start fresh from 1.
        await client.query(
          'TRUNCATE tool_usage, stock_movements, facility_stock, state_movements, state_stock RESTART IDENTITY'
        );
      } else {
        const sid = scope.stateId;
        // stock_movements has self-referencing FKs (related_movement_id,
        // dispute_resolution_movement_id) declared ON DELETE RESTRICT, so null
        // them out before deleting the state's rows.
        await client.query(
          `WITH sf AS (SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1)
           UPDATE stock_movements
              SET related_movement_id = NULL, dispute_resolution_movement_id = NULL
            WHERE facility_id IN (SELECT id FROM sf)`, [sid]);
        await client.query(
          `WITH sf AS (SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1)
           DELETE FROM tool_usage WHERE facility_id IN (SELECT id FROM sf)`, [sid]);
        await client.query(
          `WITH sf AS (SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1)
           DELETE FROM stock_movements WHERE facility_id IN (SELECT id FROM sf)`, [sid]);
        await client.query(
          `WITH sf AS (SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1)
           DELETE FROM facility_stock WHERE facility_id IN (SELECT id FROM sf)`, [sid]);
        await client.query('DELETE FROM state_movements WHERE state_id = $1', [sid]);
        await client.query('DELETE FROM state_stock     WHERE state_id = $1', [sid]);
      }
    });

    // 4. Server-side audit trace. Supabase log capture preserves this.
    const scopeLabel = scope.isGlobal ? 'ALL STATES' : `state "${scope.stateName}" (id ${scope.stateId})`;
    console.warn(
      `[admin reset] ${scopeLabel} performed by ${req.user.username} (id ${req.user.id}) — ` +
      `cleared ${counts.movements} movements, ${counts.usage} usage, ${counts.stock} stock, ` +
      `${counts.state_movements} state-movements, ${counts.state_stock} state-stock`
    );

    res.json({
      message: scope.isGlobal
        ? 'Operational data has been reset for all states'
        : `Operational data has been reset for ${scope.stateName}`,
      scope: { is_global: scope.isGlobal, state_name: scope.stateName },
      cleared: {
        stock_movements: counts.movements,
        tool_usage:      counts.usage,
        facility_stock:  counts.stock,
        state_movements: counts.state_movements,
        state_stock:     counts.state_stock,
      },
    });
  })
);

module.exports = router;
