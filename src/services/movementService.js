// All stock-mutating operations live here and run inside a single DB transaction.
// The pattern is always:
//   1. Validate business rules (facility/tool exist, sufficient stock for decrements)
//   2. INSERT into stock_movements (the immutable ledger)
//   3. UPSERT / UPDATE facility_stock (the denormalized balance)
// Both writes share the same client so either both commit or both roll back.
//
// Acknowledgement workflow (added in migration 006):
//   - RECEIPT and TRANSFER_IN rows are created with ack_status = 'PENDING_ACK'.
//   - The receiving facility's user clicks Accept or Dispute on /incoming.
//   - A dispute captures dispute_reason + disputed_quantity (the real count).
//   - Admin can "apply" the dispute → auto-creates an ADJUSTMENT_DECREASE
//     for (recorded - disputed) and links the two movements via
//     dispute_resolution_movement_id.

const { withTransaction } = require('../config/db');
const { badRequest, notFound, forbidden } = require('../utils/errors');

// ── Internal helpers ──────────────────────────────────────────────────────────

async function assertFacilityExists(client, facilityId) {
  const r = await client.query(
    'SELECT id FROM facilities WHERE id = $1 AND is_active = TRUE',
    [facilityId]
  );
  if (r.rows.length === 0) throw notFound(`Facility ${facilityId} not found or inactive`);
}

async function assertToolExists(client, toolId) {
  const r = await client.query(
    'SELECT id FROM tools WHERE id = $1 AND is_active = TRUE',
    [toolId]
  );
  if (r.rows.length === 0) throw notFound(`Tool ${toolId} not found or inactive`);
}

async function getCurrentStock(client, facilityId, toolId) {
  const r = await client.query(
    'SELECT quantity FROM facility_stock WHERE facility_id = $1 AND tool_id = $2',
    [facilityId, toolId]
  );
  return r.rows.length > 0 ? r.rows[0].quantity : 0;
}

async function adjustBalance(client, facilityId, toolId, delta) {
  await client.query(
    `INSERT INTO facility_stock (facility_id, tool_id, quantity, last_movement_at)
     VALUES ($1, $2, GREATEST(0, $3), NOW())
     ON CONFLICT (facility_id, tool_id)
     DO UPDATE SET
       quantity         = GREATEST(0, facility_stock.quantity + $3),
       last_movement_at = NOW(),
       updated_at       = NOW()`,
    [facilityId, toolId, delta]
  );
}

async function insertMovement(client, fields) {
  const {
    movement_type,
    facility_id,
    tool_id,
    quantity,
    related_facility_id = null,
    related_movement_id = null,
    reference_no = null,
    reason = null,
    note = null,
    performed_by,
    ack_status = null,
  } = fields;

  const r = await client.query(
    `INSERT INTO stock_movements
       (movement_type, facility_id, tool_id, quantity,
        related_facility_id, related_movement_id,
        reference_no, reason, note, performed_by, ack_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      movement_type, facility_id, tool_id, quantity,
      related_facility_id, related_movement_id,
      reference_no, reason, note, performed_by, ack_status,
    ]
  );
  return r.rows[0];
}

// ── Public API: stock-creating operations ─────────────────────────────────────

async function recordReceipt({ facilityId, toolId, quantity, referenceNo, note, performedBy }) {
  if (quantity <= 0) throw badRequest('Quantity must be greater than zero');

  return withTransaction(async (client) => {
    await assertFacilityExists(client, facilityId);
    await assertToolExists(client, toolId);

    const movement = await insertMovement(client, {
      movement_type: 'RECEIPT',
      facility_id:   facilityId,
      tool_id:       toolId,
      quantity,
      reference_no:  referenceNo ?? null,
      note:          note ?? null,
      performed_by:  performedBy,
      ack_status:    'PENDING_ACK',
    });

    await adjustBalance(client, facilityId, toolId, quantity);
    return movement;
  });
}

async function recordAdjustment({ facilityId, toolId, quantity, type, reason, note, performedBy }) {
  if (quantity <= 0) throw badRequest('Quantity must be greater than zero');
  if (!['ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE'].includes(type)) {
    throw badRequest('Invalid adjustment type');
  }

  return withTransaction(async (client) => {
    await assertFacilityExists(client, facilityId);
    await assertToolExists(client, toolId);

    if (type === 'ADJUSTMENT_DECREASE') {
      const current = await getCurrentStock(client, facilityId, toolId);
      if (current < quantity) {
        throw badRequest(`Cannot decrease by ${quantity} — current balance is only ${current}`);
      }
    }

    const delta = type === 'ADJUSTMENT_INCREASE' ? quantity : -quantity;

    const movement = await insertMovement(client, {
      movement_type: type,
      facility_id:   facilityId,
      tool_id:       toolId,
      quantity,
      reason:        reason ?? null,
      note:          note ?? null,
      performed_by:  performedBy,
    });

    await adjustBalance(client, facilityId, toolId, delta);
    return movement;
  });
}

async function recordTransfer({ sourceFacilityId, destFacilityId, toolId, quantity, referenceNo, note, performedBy }) {
  if (quantity <= 0) throw badRequest('Quantity must be greater than zero');
  if (sourceFacilityId === destFacilityId) throw badRequest('Source and destination must differ');

  return withTransaction(async (client) => {
    await assertFacilityExists(client, sourceFacilityId);
    await assertFacilityExists(client, destFacilityId);
    await assertToolExists(client, toolId);

    const current = await getCurrentStock(client, sourceFacilityId, toolId);
    if (current < quantity) {
      throw badRequest(`Source facility only has ${current} — cannot transfer ${quantity}`);
    }

    // OUT row — no acknowledgement (sender knows what they sent).
    const outRow = await insertMovement(client, {
      movement_type:       'TRANSFER_OUT',
      facility_id:         sourceFacilityId,
      tool_id:             toolId,
      quantity,
      related_facility_id: destFacilityId,
      reference_no:        referenceNo ?? null,
      note:                note ?? null,
      performed_by:        performedBy,
    });

    // IN row — receiving facility must acknowledge.
    const inRow = await insertMovement(client, {
      movement_type:       'TRANSFER_IN',
      facility_id:         destFacilityId,
      tool_id:             toolId,
      quantity,
      related_facility_id: sourceFacilityId,
      related_movement_id: outRow.id,
      reference_no:        referenceNo ?? null,
      note:                note ?? null,
      performed_by:        performedBy,
      ack_status:          'PENDING_ACK',
    });

    await client.query(
      'UPDATE stock_movements SET related_movement_id = $1 WHERE id = $2',
      [inRow.id, outRow.id]
    );

    await adjustBalance(client, sourceFacilityId, toolId, -quantity);
    await adjustBalance(client, destFacilityId,   toolId,  quantity);

    return { out: outRow, in: inRow };
  });
}

async function recordBulkReceipt({ toolId, items, referenceNo, note, performedBy }) {
  if (!items || items.length === 0) throw badRequest('At least one facility is required');
  for (const item of items) {
    if (item.quantity <= 0) throw badRequest('All quantities must be greater than zero');
  }

  return withTransaction(async (client) => {
    await assertToolExists(client, toolId);

    const movements = [];
    for (const item of items) {
      await assertFacilityExists(client, item.facilityId);

      const movement = await insertMovement(client, {
        movement_type: 'RECEIPT',
        facility_id:   item.facilityId,
        tool_id:       toolId,
        quantity:      item.quantity,
        reference_no:  referenceNo ?? null,
        note:          note ?? null,
        performed_by:  performedBy,
        ack_status:    'PENDING_ACK',
      });

      await adjustBalance(client, item.facilityId, toolId, item.quantity);
      movements.push(movement);
    }

    return movements;
  });
}

// ── Acknowledgement workflow ──────────────────────────────────────────────────

/**
 * Facility user acknowledges an incoming receipt.
 *   decision: 'ACCEPTED' | 'DISPUTED'
 *   When DISPUTED:
 *     disputeReason: 'INCOMPLETE' | 'DAMAGED' | 'WRONG_TOOL' | 'OTHER'
 *     disputedQuantity: actual usable quantity received (>= 0)
 *     disputeNote: optional note (required for OTHER)
 *
 * The caller must enforce that `userId` belongs to the receiving facility
 * (or is admin). This service trusts that check has been done.
 */
async function acknowledgeMovement({
  movementId,
  decision,
  disputeReason,
  disputedQuantity,
  disputeNote,
  userId,
}) {
  return withTransaction(async (client) => {
    const r = await client.query(
      'SELECT * FROM stock_movements WHERE id = $1 FOR UPDATE',
      [movementId]
    );
    if (r.rows.length === 0) throw notFound('Movement not found');
    const movement = r.rows[0];

    if (!['RECEIPT', 'TRANSFER_IN'].includes(movement.movement_type)) {
      throw badRequest('Only receipts and transfer-ins can be acknowledged');
    }
    if (movement.ack_status !== 'PENDING_ACK') {
      throw badRequest(`Movement already ${movement.ack_status?.toLowerCase()}`);
    }

    if (decision === 'ACCEPTED') {
      const updated = await client.query(
        `UPDATE stock_movements
         SET ack_status = 'ACCEPTED', ack_at = NOW(), ack_by = $1
         WHERE id = $2 RETURNING *`,
        [userId, movementId]
      );
      return updated.rows[0];
    }

    if (decision !== 'DISPUTED') throw badRequest('Invalid decision');

    if (!disputeReason) throw badRequest('Dispute reason is required');
    if (disputedQuantity === undefined || disputedQuantity === null) {
      throw badRequest('Disputed quantity is required (use 0 if you received none of this tool)');
    }
    if (disputedQuantity < 0) throw badRequest('Disputed quantity cannot be negative');
    if (disputeReason === 'OTHER' && !disputeNote?.trim()) {
      throw badRequest('A note is required when the reason is "Other"');
    }

    const updated = await client.query(
      `UPDATE stock_movements
       SET ack_status = 'DISPUTED', ack_at = NOW(), ack_by = $1,
           dispute_reason = $2, disputed_quantity = $3, dispute_note = $4
       WHERE id = $5 RETURNING *`,
      [userId, disputeReason, disputedQuantity, disputeNote ?? null, movementId]
    );
    return updated.rows[0];
  });
}

/**
 * Admin applies the auto-suggested adjustment for a disputed movement.
 * Creates an ADJUSTMENT_DECREASE for (recorded_quantity - disputed_quantity)
 * at the receiving facility, then marks the original dispute resolved.
 *
 * If disputed_quantity >= recorded_quantity, no adjustment is created
 * (the dispute is just marked resolved — admin can record a separate
 *  adjustment later if they wish).
 */
async function applyDisputeResolution({ movementId, performedBy }) {
  return withTransaction(async (client) => {
    const r = await client.query(
      'SELECT * FROM stock_movements WHERE id = $1 FOR UPDATE',
      [movementId]
    );
    if (r.rows.length === 0) throw notFound('Movement not found');
    const movement = r.rows[0];

    if (movement.ack_status !== 'DISPUTED') throw badRequest('Movement is not disputed');
    if (movement.dispute_resolved_at) throw badRequest('Dispute already resolved');

    const recorded = movement.quantity;
    const actual   = movement.disputed_quantity;
    const diff     = recorded - actual;

    let adjustment = null;

    if (diff > 0) {
      // Make sure the balance can cover the decrease — if facility has
      // already used some of the tool since acknowledgement, the balance
      // might be lower than the dispute diff. Cap to current balance.
      const current = await getCurrentStock(client, movement.facility_id, movement.tool_id);
      const safeDiff = Math.min(diff, current);

      if (safeDiff > 0) {
        const reasonText = `Dispute resolution: ${movement.dispute_reason.replace('_', ' ').toLowerCase()}`;
        const noteText   = `Resolves disputed receipt #${movement.id}.${
          movement.dispute_note ? ` Reporter note: ${movement.dispute_note}` : ''
        }`;

        adjustment = await insertMovement(client, {
          movement_type: 'ADJUSTMENT_DECREASE',
          facility_id:   movement.facility_id,
          tool_id:       movement.tool_id,
          quantity:      safeDiff,
          reason:        reasonText,
          note:          noteText,
          performed_by:  performedBy,
        });

        await adjustBalance(client, movement.facility_id, movement.tool_id, -safeDiff);
      }
    }

    await client.query(
      `UPDATE stock_movements
       SET dispute_resolved_at = NOW(),
           dispute_resolution_movement_id = $1
       WHERE id = $2`,
      [adjustment?.id ?? null, movementId]
    );

    return { resolved: true, adjustment };
  });
}

module.exports = {
  recordReceipt,
  recordAdjustment,
  recordTransfer,
  recordBulkReceipt,
  acknowledgeMovement,
  applyDisputeResolution,
};
