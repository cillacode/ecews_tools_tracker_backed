const express = require('express');
const { z } = require('zod');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { notFound, forbidden, badRequest } = require('../utils/errors');
const { applyFacilityScope } = require('../middleware/scope');
const {
  recordReceipt,
  recordAdjustment,
  recordTransfer,
  recordBulkReceipt,
  acknowledgeMovement,
  applyDisputeResolution,
} = require('../services/movementService');

const router = express.Router();

// Shared SELECT — includes acknowledgement columns + a sender label that handles
// both RECEIPT (admin name) and TRANSFER_IN (source facility name) cleanly.
const MOVEMENT_SELECT = `
  SELECT
    m.id,
    m.movement_type,
    m.quantity,
    m.reference_no,
    m.reason,
    m.note,
    m.performed_at,
    m.created_at,
    -- Acknowledgement
    m.ack_status,
    m.ack_at,
    m.ack_by,
    m.dispute_reason,
    m.disputed_quantity,
    m.dispute_note,
    m.dispute_resolved_at,
    m.dispute_resolution_movement_id,
    -- Facility
    f.id   AS facility_id,
    f.name AS facility_name,
    -- Tool
    t.id   AS tool_id,
    t.name AS tool_name,
    ta.name AS thematic_area_name,
    -- Related facility (transfers)
    rf.id   AS related_facility_id,
    rf.name AS related_facility_name,
    -- Performed by (admin / sender)
    u.id        AS performed_by_id,
    u.full_name AS performed_by_name,
    -- Acknowledged by
    ack_user.full_name AS ack_by_name
  FROM stock_movements m
  JOIN facilities     f  ON f.id  = m.facility_id
  JOIN tools          t  ON t.id  = m.tool_id
  JOIN thematic_areas ta ON ta.id = t.thematic_area_id
  LEFT JOIN facilities rf       ON rf.id       = m.related_facility_id
  LEFT JOIN users      u        ON u.id        = m.performed_by
  LEFT JOIN users      ack_user ON ack_user.id = m.ack_by
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Movements use the shared facility scope on m.facility_id.
const applyAccessScope = (req, conditions, params, columnRef = 'm.facility_id') =>
  applyFacilityScope(req, conditions, params, columnRef);

// Confirms the movement belongs to this user's accessible scope (facility / LGA / state).
async function assertFacilityScope(req, movementId) {
  const { role } = req.user;
  if (role === 'super_admin') return;
  const r = await pool.query(
    `SELECT m.facility_id, f.lga_id, l.state_id
     FROM stock_movements m
     JOIN facilities f ON f.id = m.facility_id
     JOIN lgas       l ON l.id = f.lga_id
     WHERE m.id = $1`,
    [movementId]
  );
  if (r.rows.length === 0) throw notFound('Movement not found');
  const row = r.rows[0];
  if (role === 'facility_user' && row.facility_id !== req.user.facility_id) {
    throw forbidden('You can only act on your own facility\'s movements');
  }
  if (role === 'dso' && row.lga_id !== req.user.lga_id) {
    throw forbidden('You can only view movements within your LGA');
  }
  if (['admin', 'central_logistics', 'viewer'].includes(role)
      && req.user.effective_state_id
      && row.state_id !== req.user.effective_state_id) {
    throw forbidden('You can only access movements in your state');
  }
}

// ── POST /api/movements/receipt ───────────────────────────────────────────────
const receiptSchema = z.object({
  facility_id:  z.number().int().positive('Facility is required'),
  tool_id:      z.number().int().positive('Tool is required'),
  quantity:     z.number().int().positive('Quantity must be at least 1'),
  reference_no: z.string().trim().optional(),
  note:         z.string().trim().optional(),
});

router.post(
  '/receipt',
  requireAuth,
  requireRole('admin', 'central_logistics'),
  validate(receiptSchema),
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, quantity, reference_no, note } = req.body;
    const movement = await recordReceipt({
      facilityId:  facility_id,
      toolId:      tool_id,
      quantity,
      referenceNo: reference_no,
      note,
      performedBy: req.user.id,
    });
    res.status(201).json({ data: movement });
  })
);

// ── POST /api/movements/adjustment ───────────────────────────────────────────
const adjustmentSchema = z.object({
  facility_id: z.number().int().positive('Facility is required'),
  tool_id:     z.number().int().positive('Tool is required'),
  quantity:    z.number().int().positive('Quantity must be at least 1'),
  type:        z.enum(['ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE']),
  reason:      z.string().trim().min(1, 'Reason is required for adjustments'),
  note:        z.string().trim().optional(),
});

router.post(
  '/adjustment',
  requireAuth,
  requireRole('admin'),
  validate(adjustmentSchema),
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, quantity, type, reason, note } = req.body;
    const movement = await recordAdjustment({
      facilityId:  facility_id,
      toolId:      tool_id,
      quantity,
      type,
      reason,
      note,
      performedBy: req.user.id,
    });
    res.status(201).json({ data: movement });
  })
);

// ── POST /api/movements/bulk-receipt ─────────────────────────────────────────
// Each line carries its own tool, so one submission can send many tools to many
// facilities (the matrix grid).
const bulkReceiptSchema = z.object({
  items:        z.array(z.object({
    tool_id:     z.number().int().positive(),
    facility_id: z.number().int().positive(),
    quantity:    z.number().int().positive(),
  })).min(1, 'At least one line is required'),
  reference_no: z.string().trim().optional(),
  note:         z.string().trim().optional(),
});

router.post(
  '/bulk-receipt',
  requireAuth,
  requireRole('admin', 'central_logistics'),
  validate(bulkReceiptSchema),
  asyncHandler(async (req, res) => {
    const { items, reference_no, note } = req.body;
    const movements = await recordBulkReceipt({
      items:       items.map((i) => ({ toolId: i.tool_id, facilityId: i.facility_id, quantity: i.quantity })),
      referenceNo: reference_no,
      note,
      performedBy: req.user.id,
    });
    res.status(201).json({ data: movements, count: movements.length });
  })
);

// ── POST /api/movements/transfer ─────────────────────────────────────────────
// Facility users may transfer FROM their own facility only.
const transferSchema = z.object({
  source_facility_id: z.number().int().positive(),
  dest_facility_id:   z.number().int().positive(),
  tool_id:            z.number().int().positive(),
  quantity:           z.number().int().positive(),
  reference_no:       z.string().trim().optional(),
  note:               z.string().trim().optional(),
});

router.post(
  '/transfer',
  requireAuth,
  requireRole('admin', 'facility_user'),
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const { source_facility_id, dest_facility_id, tool_id, quantity, reference_no, note } = req.body;

    if (req.user.role === 'facility_user' && source_facility_id !== req.user.facility_id) {
      throw forbidden('You can only transfer from your own facility');
    }

    const result = await recordTransfer({
      sourceFacilityId: source_facility_id,
      destFacilityId:   dest_facility_id,
      toolId:           tool_id,
      quantity,
      referenceNo:      reference_no,
      note,
      performedBy:      req.user.id,
    });
    res.status(201).json({ data: result });
  })
);

// ── GET /api/movements/incoming ──────────────────────────────────────────────
// Pending acknowledgements for the current user's facility (facility_user)
// or system-wide (admin/central_logistics).
router.get(
  '/incoming',
  requireAuth,
  asyncHandler(async (req, res) => {
    const conditions = [
      `m.movement_type IN ('RECEIPT', 'TRANSFER_IN')`,
      `m.ack_status = 'PENDING_ACK'`,
    ];
    const params = [];

    applyAccessScope(req, conditions, params);

    const result = await pool.query(
      `${MOVEMENT_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.performed_at DESC`,
      params
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/movements/disputes ──────────────────────────────────────────────
// Open disputes awaiting admin resolution.
router.get(
  '/disputes',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const conditions = [`m.ack_status = 'DISPUTED'`, `m.dispute_resolved_at IS NULL`];
    const params = [];
    applyAccessScope(req, conditions, params); // state admins → their state only
    const result = await pool.query(
      `${MOVEMENT_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.ack_at DESC`,
      params
    );
    res.json({ data: result.rows });
  })
);

// ── POST /api/movements/:id/acknowledge ──────────────────────────────────────
const acknowledgeSchema = z.object({
  decision:          z.enum(['ACCEPTED', 'DISPUTED']),
  dispute_reason:    z.enum(['INCOMPLETE', 'DAMAGED', 'WRONG_TOOL', 'OTHER']).optional(),
  disputed_quantity: z.number().int().min(0).optional(),
  dispute_note:      z.string().trim().optional(),
});

router.post(
  '/:id/acknowledge',
  requireAuth,
  validate(acknowledgeSchema),
  asyncHandler(async (req, res) => {
    const movementId = parseInt(req.params.id, 10);
    if (isNaN(movementId)) throw badRequest('Invalid movement id');

    await assertFacilityScope(req, movementId);

    const { decision, dispute_reason, disputed_quantity, dispute_note } = req.body;

    const result = await acknowledgeMovement({
      movementId,
      decision,
      disputeReason:    dispute_reason,
      disputedQuantity: disputed_quantity,
      disputeNote:      dispute_note,
      userId:           req.user.id,
    });

    res.json({ data: result });
  })
);

// ── POST /api/movements/:id/apply-dispute (admin only) ───────────────────────
router.post(
  '/:id/apply-dispute',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const movementId = parseInt(req.params.id, 10);
    if (isNaN(movementId)) throw badRequest('Invalid movement id');

    await assertFacilityScope(req, movementId); // state admins → their state only

    const result = await applyDisputeResolution({
      movementId,
      performedBy: req.user.id,
    });
    res.json({ data: result });
  })
);

// ── GET /api/movements ───────────────────────────────────────────────────────
const listQuerySchema = z.object({
  facility_id: z.coerce.number().int().positive().optional(),
  tool_id:     z.coerce.number().int().positive().optional(),
  type:        z.enum(['RECEIPT','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT_INCREASE','ADJUSTMENT_DECREASE']).optional(),
  from:        z.string().optional(),
  to:          z.string().optional(),
  page:        z.coerce.number().int().positive().default(1),
  limit:       z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
  '/',
  requireAuth,
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, type, from, to, page, limit } = req.query;

    const conditions = [];
    const params = [];

    // Facility users and DSOs are scoped automatically. Other roles may
    // optionally pass a facility_id filter.
    const scoped = applyAccessScope(req, conditions, params);
    if (!scoped && facility_id) {
      params.push(facility_id);
      conditions.push(`m.facility_id = $${params.length}`);
    }

    if (tool_id) { params.push(tool_id); conditions.push(`m.tool_id = $${params.length}`); }
    if (type)    { params.push(type);    conditions.push(`m.movement_type = $${params.length}`); }
    if (from)    { params.push(from);    conditions.push(`m.performed_at >= $${params.length}`); }
    if (to)      { params.push(to);      conditions.push(`m.performed_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM stock_movements m ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await pool.query(
      `${MOVEMENT_SELECT}
       ${where}
       ORDER BY m.performed_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  })
);

// ── GET /api/movements/:id ───────────────────────────────────────────────────
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertFacilityScope(req, parseInt(req.params.id, 10));
    const result = await pool.query(`${MOVEMENT_SELECT} WHERE m.id = $1`, [req.params.id]);
    if (result.rows.length === 0) throw notFound('Movement not found');
    res.json({ data: result.rows[0] });
  })
);

module.exports = router;
