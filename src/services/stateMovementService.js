// HQ → State distribution. Mirrors the facility movement service but at the
// state tier. Each receipt inserts a state_movements ledger row and bumps the
// state_stock balance, in one transaction.

const { withTransaction } = require('../config/db');
const { badRequest, notFound } = require('../utils/errors');

async function assertStateExists(client, stateId) {
  const r = await client.query('SELECT id FROM states WHERE id = $1', [stateId]);
  if (r.rows.length === 0) throw notFound(`State ${stateId} not found`);
}

async function assertToolExists(client, toolId) {
  const r = await client.query('SELECT id FROM tools WHERE id = $1 AND is_active = TRUE', [toolId]);
  if (r.rows.length === 0) throw notFound(`Tool ${toolId} not found or inactive`);
}

async function bumpStateBalance(client, stateId, toolId, delta) {
  await client.query(
    `INSERT INTO state_stock (state_id, tool_id, quantity, last_movement_at)
     VALUES ($1, $2, GREATEST(0, $3), NOW())
     ON CONFLICT (state_id, tool_id)
     DO UPDATE SET
       quantity         = GREATEST(0, state_stock.quantity + $3),
       last_movement_at = NOW(),
       updated_at       = NOW()`,
    [stateId, toolId, delta]
  );
}

async function insertStateMovement(client, { stateId, toolId, quantity, referenceNo, note, performedBy }) {
  const r = await client.query(
    `INSERT INTO state_movements (movement_type, state_id, tool_id, quantity, reference_no, note, performed_by)
     VALUES ('RECEIPT', $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [stateId, toolId, quantity, referenceNo ?? null, note ?? null, performedBy]
  );
  return r.rows[0];
}

// Record one tool sent to one state.
async function recordStateReceipt({ stateId, toolId, quantity, referenceNo, note, performedBy }) {
  if (quantity <= 0) throw badRequest('Quantity must be greater than zero');
  return withTransaction(async (client) => {
    await assertStateExists(client, stateId);
    await assertToolExists(client, toolId);
    const movement = await insertStateMovement(client, { stateId, toolId, quantity, referenceNo, note, performedBy });
    await bumpStateBalance(client, stateId, toolId, quantity);
    return movement;
  });
}

// Multi-tool bulk distribution to states in a single transaction. Each item is
// a full line: { toolId, stateId, quantity } — many tools to many states.
async function recordStateBulkReceipt({ items, referenceNo, note, performedBy }) {
  if (!items || items.length === 0) throw badRequest('At least one line is required');
  for (const i of items) {
    if (i.quantity <= 0) throw badRequest('All quantities must be greater than zero');
  }
  return withTransaction(async (client) => {
    const movements = [];
    for (const item of items) {
      await assertStateExists(client, item.stateId);
      await assertToolExists(client, item.toolId);
      const m = await insertStateMovement(client, {
        stateId: item.stateId, toolId: item.toolId, quantity: item.quantity, referenceNo, note, performedBy,
      });
      await bumpStateBalance(client, item.stateId, item.toolId, item.quantity);
      movements.push(m);
    }
    return movements;
  });
}

module.exports = { recordStateReceipt, recordStateBulkReceipt };
