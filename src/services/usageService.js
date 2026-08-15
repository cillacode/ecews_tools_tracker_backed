// Daily tool-usage tracking — additive model.
//
// Each (facility, tool, usage_date) holds ONE canonical row in tool_usage
// that accumulates usage for that day. Submitting an entry ADDS to the
// existing count for the day (it does not replace it). Stock is always
// debited by exactly the amount submitted — never credited back.
//
// Weekly aggregates (for the tracker and weekly reports) are computed by
// summing daily rows whose usage_date falls within the week — see the
// tracker route.
//
// Corrections downward (e.g., overstated usage) are out of scope here;
// admin can use the Adjust Stock feature to undo if needed.

const { withTransaction } = require('../config/db');
const { badRequest, notFound } = require('../utils/errors');

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

// Decrement the facility's stock by `amount` (always non-negative).
// Creates a facility_stock row at 0 if missing — stock can never go below 0.
async function decrementStock(client, facilityId, toolId, amount) {
  if (amount <= 0) return;
  await client.query(
    `INSERT INTO facility_stock (facility_id, tool_id, quantity, last_movement_at)
     VALUES ($1, $2, 0, NOW())
     ON CONFLICT (facility_id, tool_id)
     DO UPDATE SET
       quantity         = GREATEST(0, facility_stock.quantity - $3),
       last_movement_at = NOW(),
       updated_at       = NOW()`,
    [facilityId, toolId, amount]
  );
}

/**
 * Record additional usage for one or more tools on a specific day.
 *   entries: [{ tool_id, count, note }] — count is the amount to ADD.
 *   Zero-count entries are skipped.
 *
 * Same-day re-records are additive: previous count + new count.
 * Stock is debited by the amount added (never credited back).
 */
async function recordDailyUsage({ facilityId, usageDate, entries, recordedBy }) {
  if (!entries || entries.length === 0) throw badRequest('At least one entry required');
  for (const e of entries) {
    if (e.count < 0) throw badRequest('Usage count cannot be negative');
  }

  return withTransaction(async (client) => {
    await assertFacilityExists(client, facilityId);

    // Pre-validate ALL non-zero entries against current stock before writing
    // anything. The whole batch is rejected if any tool would over-draw, or if
    // a physically-counted balance doesn't reconcile — keeps the ledger and
    // tracker math reconcilable and forces a genuine physical recount.
    for (const entry of entries) {
      if (entry.count === 0) continue;
      await assertToolExists(client, entry.tool_id);

      const stockRes = await client.query(
        `SELECT quantity FROM facility_stock WHERE facility_id = $1 AND tool_id = $2`,
        [facilityId, entry.tool_id]
      );
      const available = stockRes.rows[0]?.quantity ?? 0;

      const toolName = async () => {
        const r = await client.query('SELECT name FROM tools WHERE id = $1', [entry.tool_id]);
        return r.rows[0]?.name ?? `Tool #${entry.tool_id}`;
      };

      if (entry.count > available) {
        const name = await toolName();
        throw badRequest(
          available === 0
            ? `${name} is out of stock — nothing to record. Ask admin to receive more before logging usage.`
            : `Not enough ${name}: only ${available} on hand, you tried to record ${entry.count}.`
        );
      }

      // Physical-count validation (hard block). Expected on-hand after giving
      // out `count` = current stock − count. If the physically counted balance
      // doesn't match, the entry is rejected until it reconciles.
      if (entry.physical_balance !== undefined && entry.physical_balance !== null) {
        const expected = available - entry.count;
        if (entry.physical_balance !== expected) {
          const name = await toolName();
          throw badRequest(
            `${name}: the physical balance you entered (${entry.physical_balance}) does not tally with the expected ` +
            `balance (${expected} = ${available} on hand − ${entry.count} given out). Kindly recount the physical tool.`
          );
        }
      }
    }

    const results = [];
    for (const entry of entries) {
      if (entry.count === 0) continue; // skip no-op entries silently

      // Pull existing total for the day so we can ADD on top of it.
      const existing = await client.query(
        `SELECT usage_count
         FROM tool_usage
         WHERE facility_id = $1 AND tool_id = $2 AND usage_date = $3`,
        [facilityId, entry.tool_id, usageDate]
      );
      const oldCount = existing.rows[0]?.usage_count ?? 0;
      const newTotal = oldCount + entry.count;

      const upsert = await client.query(
        `INSERT INTO tool_usage
           (facility_id, tool_id, usage_date, usage_count, note, recorded_by, service_point_id, physical_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (facility_id, tool_id, usage_date)
         DO UPDATE SET
           usage_count      = $4,
           note             = COALESCE($5, tool_usage.note),
           recorded_by      = $6,
           service_point_id = COALESCE($7, tool_usage.service_point_id),
           physical_balance = $8,
           updated_at       = NOW()
         RETURNING *`,
        [facilityId, entry.tool_id, usageDate, newTotal, entry.note ?? null, recordedBy,
         entry.service_point_id ?? null, entry.physical_balance ?? null]
      );

      // Always decrement stock by the amount added (never credit back).
      await decrementStock(client, facilityId, entry.tool_id, entry.count);

      results.push(upsert.rows[0]);
    }

    return results;
  });
}

module.exports = { recordDailyUsage };
