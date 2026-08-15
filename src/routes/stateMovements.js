const express = require('express');
const { z }   = require('zod');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { badRequest, forbidden, notFound } = require('../utils/errors');
const { recordStateReceipt, recordStateBulkReceipt } = require('../services/stateMovementService');

const router = express.Router();

// HQ recording endpoints are super_admin only.
const onlySuper = [requireAuth, requireRole('super_admin')];

// The state a state-admin acts within. super_admin may pass ?state_id.
function actorStateId(req) {
  if (req.user.role === 'super_admin') {
    const s = parseInt(req.query.state_id, 10);
    return Number.isInteger(s) ? s : null; // null = all states
  }
  if (!req.user.effective_state_id) throw badRequest('User has no state context');
  return req.user.effective_state_id;
}

// ── POST /api/state-movements/receipt ─────────────────────────────────────────
// One tool → one state.
const receiptSchema = z.object({
  state_id:     z.number().int().positive('State is required'),
  tool_id:      z.number().int().positive('Tool is required'),
  quantity:     z.number().int().positive('Quantity must be at least 1'),
  reference_no: z.string().trim().optional(),
  note:         z.string().trim().optional(),
});

router.post(
  '/receipt',
  ...onlySuper,
  validate(receiptSchema),
  asyncHandler(async (req, res) => {
    const { state_id, tool_id, quantity, reference_no, note } = req.body;
    const movement = await recordStateReceipt({
      stateId: state_id, toolId: tool_id, quantity,
      referenceNo: reference_no, note, performedBy: req.user.id,
    });
    res.status(201).json({ data: movement });
  })
);

// ── POST /api/state-movements/bulk-receipt ────────────────────────────────────
// Many tools → many states (matrix grid). Each line carries its own tool.
const bulkSchema = z.object({
  items:        z.array(z.object({
    tool_id:  z.number().int().positive(),
    state_id: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1, 'At least one line is required'),
  reference_no: z.string().trim().optional(),
  note:         z.string().trim().optional(),
});

router.post(
  '/bulk-receipt',
  ...onlySuper,
  validate(bulkSchema),
  asyncHandler(async (req, res) => {
    const { items, reference_no, note } = req.body;
    const movements = await recordStateBulkReceipt({
      items:  items.map((i) => ({ toolId: i.tool_id, stateId: i.state_id, quantity: i.quantity })),
      referenceNo: reference_no, note, performedBy: req.user.id,
    });
    res.status(201).json({ data: movements, count: movements.length });
  })
);

// ── GET /api/state-movements ──────────────────────────────────────────────────
// State-level distribution log. Filters: ?state_id, ?tool_id, ?from, ?to. Paginated.
const listSchema = z.object({
  state_id: z.coerce.number().int().positive().optional(),
  tool_id:  z.coerce.number().int().positive().optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
  page:     z.coerce.number().int().positive().default(1),
  limit:    z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
  '/',
  ...onlySuper,
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { state_id, tool_id, from, to, page, limit } = req.query;
    const conditions = [];
    const params = [];

    if (state_id) { params.push(state_id); conditions.push(`sm.state_id = $${params.length}`); }
    if (tool_id)  { params.push(tool_id);  conditions.push(`sm.tool_id = $${params.length}`); }
    if (from)     { params.push(from);     conditions.push(`sm.performed_at >= $${params.length}`); }
    if (to)       { params.push(to);       conditions.push(`sm.performed_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM state_movements sm ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT
         sm.id, sm.quantity, sm.reference_no, sm.note, sm.performed_at,
         s.id   AS state_id,
         s.name AS state_name,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         u.full_name AS performed_by_name
       FROM state_movements sm
       JOIN states         s  ON s.id  = sm.state_id
       JOIN tools          t  ON t.id  = sm.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = sm.performed_by
       ${where}
       ORDER BY sm.performed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: result.rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  })
);

// ── GET /api/state-movements/coverage ─────────────────────────────────────────
// Per-state summary for the super-admin dashboard: tools sent + total qty.
router.get(
  '/coverage',
  ...onlySuper,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         s.id                                AS state_id,
         s.name                              AS state_name,
         COUNT(ss.tool_id) FILTER (WHERE ss.quantity > 0)::int AS tools_stocked,
         COALESCE(SUM(ss.quantity), 0)::int  AS total_quantity,
         MAX(ss.last_movement_at)            AS last_movement_at
       FROM states s
       LEFT JOIN state_stock ss ON ss.state_id = s.id
       GROUP BY s.id, s.name
       ORDER BY s.name`
    );
    res.json({ data: result.rows });
  })
);

// ── GET /api/state-movements/stock ────────────────────────────────────────────
// The state's own tool ledger: for each tool HQ has sent, how much was received,
// how much the state has distributed to its facilities, and the balance left.
// State admins see their own state; super_admin may pass ?state_id.
router.get(
  '/stock',
  requireAuth,
  requireRole('admin', 'super_admin'),
  asyncHandler(async (req, res) => {
    const stateId = actorStateId(req);
    if (!stateId) {
      // super_admin without a chosen state — nothing to show.
      return res.json({ data: [], meta: { received: 0, distributed: 0, available: 0 } });
    }

    const result = await pool.query(
      `WITH state_facilities AS (
         SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id
         WHERE l.state_id = $1 AND f.is_active = TRUE
       ),
       distributed AS (
         SELECT m.tool_id, SUM(m.quantity)::int AS sent_out
         FROM stock_movements m
         WHERE m.movement_type = 'RECEIPT'
           AND m.facility_id IN (SELECT id FROM state_facilities)
         GROUP BY m.tool_id
       )
       SELECT
         t.id    AS tool_id,
         t.name  AS tool_name,
         ta.id   AS thematic_area_id,
         ta.name AS thematic_area_name,
         ta.sort_order,
         ss.quantity::int                                         AS received,
         COALESCE(d.sent_out, 0)                                  AS distributed,
         GREATEST(0, ss.quantity - COALESCE(d.sent_out, 0))       AS available,
         ss.last_movement_at
       FROM state_stock ss
       JOIN tools          t  ON t.id  = ss.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN distributed d ON d.tool_id = ss.tool_id
       WHERE ss.state_id = $1
       ORDER BY ta.sort_order, t.name`,
      [stateId]
    );

    const rows = result.rows;
    const meta = rows.reduce(
      (acc, r) => ({
        received:    acc.received + r.received,
        distributed: acc.distributed + r.distributed,
        available:   acc.available + r.available,
      }),
      { received: 0, distributed: 0, available: 0 }
    );

    res.json({ data: rows, meta });
  })
);

// ══════════════════════════════════════════════════════════════════════════
// State acknowledgement of HQ receipts (state admin / super_admin)
// ══════════════════════════════════════════════════════════════════════════

const SELECT_STATE_MOVEMENT = `
  SELECT
    sm.id, sm.quantity, sm.reference_no, sm.note, sm.performed_at,
    sm.ack_status, sm.ack_at, sm.receiver_names, sm.ack_note,
    s.id   AS state_id,
    s.name AS state_name,
    t.id   AS tool_id,
    t.name AS tool_name,
    ta.name AS thematic_area_name,
    u.full_name  AS performed_by_name,
    au.full_name AS ack_by_name
  FROM state_movements sm
  JOIN states         s  ON s.id  = sm.state_id
  JOIN tools          t  ON t.id  = sm.tool_id
  JOIN thematic_areas ta ON ta.id = t.thematic_area_id
  LEFT JOIN users u  ON u.id  = sm.performed_by
  LEFT JOIN users au ON au.id = sm.ack_by
`;

// ── GET /api/state-movements/incoming ─────────────────────────────────────────
// Pending HQ receipts awaiting the state admin's acknowledgement.
router.get(
  '/incoming',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const stateId = actorStateId(req);
    const conditions = [`sm.ack_status = 'PENDING_ACK'`];
    const params = [];
    if (stateId) { params.push(stateId); conditions.push(`sm.state_id = $${params.length}`); }

    const result = await pool.query(
      `${SELECT_STATE_MOVEMENT} WHERE ${conditions.join(' AND ')} ORDER BY sm.performed_at DESC`,
      params
    );
    res.json({ data: result.rows });
  })
);

// ── GET /api/state-movements/history ──────────────────────────────────────────
// Acknowledged HQ receipts — the "HQ Receipts" history.
router.get(
  '/history',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const stateId = actorStateId(req);
    const conditions = [`sm.ack_status = 'ACCEPTED'`];
    const params = [];
    if (stateId) { params.push(stateId); conditions.push(`sm.state_id = $${params.length}`); }

    const result = await pool.query(
      `${SELECT_STATE_MOVEMENT} WHERE ${conditions.join(' AND ')} ORDER BY sm.ack_at DESC`,
      params
    );
    res.json({ data: result.rows });
  })
);

// ── POST /api/state-movements/:id/acknowledge ─────────────────────────────────
// State admin confirms physical receipt. Accept-only; receiver_names required.
const ackSchema = z.object({
  receiver_names: z.string().trim().min(1, 'Receiver name(s) required'),
  note:           z.string().trim().optional(),
});

router.post(
  '/:id/acknowledge',
  requireAuth,
  requireRole('admin'),
  validate(ackSchema),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw badRequest('Invalid id');

    const existing = await pool.query('SELECT state_id, ack_status FROM state_movements WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw notFound('Receipt not found');
    const row = existing.rows[0];

    // A state admin can only acknowledge their own state's receipts.
    if (req.user.role !== 'super_admin' && row.state_id !== req.user.effective_state_id) {
      throw forbidden('You can only acknowledge receipts for your own state');
    }
    if (row.ack_status === 'ACCEPTED') throw badRequest('This receipt is already acknowledged');

    const updated = await pool.query(
      `UPDATE state_movements
         SET ack_status = 'ACCEPTED', ack_at = NOW(), ack_by = $1,
             receiver_names = $2, ack_note = $3
       WHERE id = $4 RETURNING *`,
      [req.user.id, req.body.receiver_names, req.body.note ?? null, id]
    );
    res.json({ data: updated.rows[0] });
  })
);

module.exports = router;
