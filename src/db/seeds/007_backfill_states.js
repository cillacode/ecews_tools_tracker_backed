// Backfill for multi-state rollout.
//
// 1. The default admin account (env DEFAULT_ADMIN_USERNAME) is promoted to
//    super_admin — sees all states, no scope columns set.
// 2. Any OTHER admin / central_logistics / viewer accounts that exist from
//    Phase 1/2 testing get assigned to Lagos (the only state they could
//    possibly have meant when they were created).
// 3. facility_user and dso accounts are untouched — their state derives
//    from facility_id / lga_id and stays consistent.
//
// Safe to re-run: every UPDATE is guarded.

const { pool, withTransaction } = require('../../config/db');

module.exports = async function backfillStates() {
  const defaultAdminUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';

  await withTransaction(async (client) => {
    // ── 1. Find Lagos's state_id ──
    const lagosRes = await client.query(
      `SELECT id FROM states WHERE name = 'Lagos' LIMIT 1`
    );
    if (lagosRes.rows.length === 0) {
      throw new Error('Lagos state row missing — earlier seed must have failed.');
    }
    const lagosId = lagosRes.rows[0].id;

    // ── 2. Promote default admin to super_admin ──
    // Use a transaction-bracketed UPDATE so the scope check holds at COMMIT.
    const promoteRes = await client.query(
      `UPDATE users
         SET role = 'super_admin',
             state_id = NULL,
             facility_id = NULL,
             lga_id = NULL,
             updated_at = NOW()
       WHERE username = $1 AND role <> 'super_admin'
       RETURNING id, username`,
      [defaultAdminUsername]
    );
    if (promoteRes.rowCount > 0) {
      console.log(`  → promoted "${promoteRes.rows[0].username}" to super_admin`);
    }

    // ── 3. Backfill OTHER state-scoped roles to Lagos ──
    const backfillRes = await client.query(
      `UPDATE users
         SET state_id = $1,
             updated_at = NOW()
       WHERE role IN ('admin', 'central_logistics', 'viewer')
         AND state_id IS NULL
       RETURNING id, username, role`,
      [lagosId]
    );
    if (backfillRes.rowCount > 0) {
      console.log(`  → backfilled ${backfillRes.rowCount} user(s) to Lagos: ` +
        backfillRes.rows.map((u) => `${u.username} (${u.role})`).join(', '));
    }
  });
};
