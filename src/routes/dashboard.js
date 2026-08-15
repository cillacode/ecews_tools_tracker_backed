const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { forbidden } = require('../utils/errors');

const router = express.Router();

// The /kpis, /recent, /coverage, /low-stock endpoints are used by
// super_admin / admin / central_logistics / viewer (facility_user and dso have
// their own scoped endpoints). For these roles the scope reduces to a single
// optional state filter: super_admin and HQ viewers see everything; everyone
// else is pinned to their effective_state_id.
//
// Returns { stateId | null }. When null, no state filter should be applied.
function dashboardStateScope(req) {
  if (req.user.role === 'super_admin') return { stateId: null };
  // Any state-bound role (admin/central/viewer) — HQ viewer has null state.
  return { stateId: req.user.effective_state_id ?? null };
}

// ── GET /api/dashboard/kpis (admin / central / viewer) ───────────────────────
router.get(
  '/kpis',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stateId } = dashboardStateScope(req);

    // Each query binds [stateId]. When stateId is null (super_admin / HQ viewer),
    // the `$1::int IS NULL OR ...` short-circuits to "all rows".
    const [tools, facilities, movementsThisMonth, lowStock, openDisputes, geo] = await Promise.all([
      // Tools are a global catalogue — never state-scoped.
      pool.query(`SELECT COUNT(*) FROM tools WHERE is_active = TRUE`),

      pool.query(
        `SELECT COUNT(*) FROM facilities f
         JOIN lgas l ON l.id = f.lga_id
         WHERE f.is_active = TRUE AND ($1::int IS NULL OR l.state_id = $1)`,
        [stateId]
      ),

      pool.query(
        `SELECT COUNT(*) FROM stock_movements m
         WHERE m.performed_at >= date_trunc('month', NOW())
           AND ($1::int IS NULL OR m.facility_id IN (
             SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1))`,
        [stateId]
      ),

      // Facilities with at least one tool at LOW stock (qty ≤ 10, zero included).
      // Matches the traffic-light thresholds in the facility stock report.
      pool.query(
        `SELECT COUNT(DISTINCT fs.facility_id) FROM facility_stock fs
         WHERE fs.quantity <= 10
           AND ($1::int IS NULL OR fs.facility_id IN (
             SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1))`,
        [stateId]
      ),

      pool.query(
        `SELECT COUNT(*) FROM stock_movements m
         WHERE m.ack_status = 'DISPUTED' AND m.dispute_resolved_at IS NULL
           AND ($1::int IS NULL OR m.facility_id IN (
             SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id WHERE l.state_id = $1))`,
        [stateId]
      ),

      // Geographic spread of the in-scope active facilities (dashboard subtitle).
      pool.query(
        `SELECT
           COUNT(DISTINCT f.lga_id)::int    AS lga_count,
           COUNT(DISTINCT l.state_id)::int  AS state_count
         FROM facilities f
         JOIN lgas l ON l.id = f.lga_id
         WHERE f.is_active = TRUE AND ($1::int IS NULL OR l.state_id = $1)`,
        [stateId]
      ),
    ]);

    res.json({
      data: {
        total_tools:           parseInt(tools.rows[0].count, 10),
        total_facilities:      parseInt(facilities.rows[0].count, 10),
        movements_this_month:  parseInt(movementsThisMonth.rows[0].count, 10),
        facilities_low_stock:  parseInt(lowStock.rows[0].count, 10),
        open_disputes:         parseInt(openDisputes.rows[0].count, 10),
        total_lgas:            geo.rows[0].lga_count,
        total_states:          geo.rows[0].state_count,
      },
    });
  })
);

// ── GET /api/dashboard/low-stock-facilities ──────────────────────────────────
// Every in-scope facility holding at least one tool at qty ≤ 10, with the
// specific low tools nested per facility. Thresholds mirror the facility
// stock report: ≤5 = "restock" (red), 6–10 = "low" (orange).
router.get(
  '/low-stock-facilities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stateId } = dashboardStateScope(req);

    const rows = (await pool.query(
      `SELECT
         f.id    AS facility_id,
         f.name  AS facility_name,
         l.name  AS lga_name,
         t.id    AS tool_id,
         t.name  AS tool_name,
         ta.name AS thematic_area_name,
         fs.quantity
       FROM facility_stock fs
       JOIN facilities     f  ON f.id  = fs.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE fs.quantity <= 10
         AND f.is_active = TRUE
         AND ($1::int IS NULL OR l.state_id = $1)
       ORDER BY l.name, f.name, fs.quantity ASC, t.name`,
      [stateId]
    )).rows;

    // Group by facility with red/orange counts for the summary row.
    const byFacility = new Map();
    for (const r of rows) {
      if (!byFacility.has(r.facility_id)) {
        byFacility.set(r.facility_id, {
          facility_id:   r.facility_id,
          facility_name: r.facility_name,
          lga_name:      r.lga_name,
          restock_count: 0,
          low_count:     0,
          tools:         [],
        });
      }
      const fac = byFacility.get(r.facility_id);
      const level = r.quantity <= 5 ? 'restock' : 'low';
      if (level === 'restock') fac.restock_count += 1; else fac.low_count += 1;
      fac.tools.push({
        tool_id:            r.tool_id,
        tool_name:          r.tool_name,
        thematic_area_name: r.thematic_area_name,
        quantity:           r.quantity,
        level,
      });
    }

    res.json({ data: Array.from(byFacility.values()) });
  })
);

// ── GET /api/dashboard/lga-kpis (dso) ────────────────────────────────────────
router.get(
  '/lga-kpis',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'dso' || !req.user.lga_id) {
      throw forbidden('Endpoint is for DSOs only');
    }
    const lga = req.user.lga_id;

    const [facilitiesRes, toolsStockedRes, totalQtyRes, monthRes, zeroRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM facilities WHERE lga_id = $1 AND is_active = TRUE`, [lga]),
      pool.query(
        `SELECT COUNT(DISTINCT fs.tool_id)::int AS n
         FROM facility_stock fs
         JOIN facilities f ON f.id = fs.facility_id
         WHERE f.lga_id = $1 AND fs.quantity > 0`,
        [lga]
      ),
      pool.query(
        `SELECT COALESCE(SUM(fs.quantity), 0)::int AS n
         FROM facility_stock fs
         JOIN facilities f ON f.id = fs.facility_id
         WHERE f.lga_id = $1`,
        [lga]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
         FROM stock_movements m
         JOIN facilities f ON f.id = m.facility_id
         WHERE f.lga_id = $1 AND m.performed_at >= date_trunc('month', NOW())`,
        [lga]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT fs.facility_id)::int AS n
         FROM facility_stock fs
         JOIN facilities f ON f.id = fs.facility_id
         WHERE f.lga_id = $1 AND fs.quantity = 0`,
        [lga]
      ),
    ]);

    res.json({
      data: {
        total_facilities:      facilitiesRes.rows[0].n,
        unique_tools_stocked:  toolsStockedRes.rows[0].n,
        total_quantity:        totalQtyRes.rows[0].n,
        movements_this_month:  monthRes.rows[0].n,
        facilities_zero_stock: zeroRes.rows[0].n,
      },
    });
  })
);

// ── GET /api/dashboard/lga-recent (dso) ──────────────────────────────────────
router.get(
  '/lga-recent',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'dso' || !req.user.lga_id) {
      throw forbidden('Endpoint is for DSOs only');
    }

    const result = await pool.query(
      `SELECT
         m.id, m.movement_type, m.quantity, m.reference_no, m.note,
         m.performed_at, m.ack_status,
         f.id   AS facility_id,
         f.name AS facility_name,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         u.full_name AS performed_by_name
       FROM stock_movements m
       JOIN facilities     f  ON f.id  = m.facility_id
       JOIN tools          t  ON t.id  = m.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users      u  ON u.id  = m.performed_by
       WHERE f.lga_id = $1
       ORDER BY m.performed_at DESC
       LIMIT 10`,
      [req.user.lga_id]
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/dashboard/lga-facilities (dso) ──────────────────────────────────
// Per-facility summary for the user's LGA — facility name, stock counts, last movement.
router.get(
  '/lga-facilities',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'dso' || !req.user.lga_id) {
      throw forbidden('Endpoint is for DSOs only');
    }

    const result = await pool.query(
      `SELECT
         f.id                                                  AS facility_id,
         f.name                                                AS facility_name,
         COUNT(fs.tool_id)::int                                AS tools_on_record,
         COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_with_stock,
         COALESCE(SUM(fs.quantity), 0)::int                    AS total_quantity,
         MAX(fs.last_movement_at)                              AS last_movement_at
       FROM facilities f
       LEFT JOIN facility_stock fs ON fs.facility_id = f.id
       WHERE f.lga_id = $1 AND f.is_active = TRUE
       GROUP BY f.id, f.name
       ORDER BY f.name`,
      [req.user.lga_id]
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/dashboard/facility-kpis (facility_user) ─────────────────────────
router.get(
  '/facility-kpis',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'facility_user' || !req.user.facility_id) {
      throw forbidden('Endpoint is for facility users only');
    }
    const fid = req.user.facility_id;

    const [stockedRes, totalQtyRes, pendingRes, monthRes, openDisputesRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM facility_stock WHERE facility_id = $1 AND quantity > 0`, [fid]),
      pool.query(`SELECT COALESCE(SUM(quantity),0)::int AS n FROM facility_stock WHERE facility_id = $1`, [fid]),
      pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE facility_id = $1 AND ack_status = 'PENDING_ACK'`, [fid]),
      pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE facility_id = $1 AND performed_at >= date_trunc('month', NOW())`, [fid]),
      pool.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE facility_id = $1 AND ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL`, [fid]),
    ]);

    res.json({
      data: {
        tools_with_stock:     stockedRes.rows[0].n,
        total_quantity:       totalQtyRes.rows[0].n,
        pending_acks:         pendingRes.rows[0].n,
        movements_this_month: monthRes.rows[0].n,
        open_disputes:        openDisputesRes.rows[0].n,
      },
    });
  })
);

// ── GET /api/dashboard/facility-recent (facility_user) ───────────────────────
router.get(
  '/facility-recent',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'facility_user' || !req.user.facility_id) {
      throw forbidden('Endpoint is for facility users only');
    }

    const result = await pool.query(
      `SELECT
         m.id, m.movement_type, m.quantity, m.reference_no, m.note,
         m.performed_at, m.ack_status,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         rf.name AS related_facility_name,
         u.full_name AS performed_by_name
       FROM stock_movements m
       JOIN tools          t  ON t.id  = m.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN facilities rf ON rf.id = m.related_facility_id
       LEFT JOIN users      u  ON u.id  = m.performed_by
       WHERE m.facility_id = $1
       ORDER BY m.performed_at DESC
       LIMIT 10`,
      [req.user.facility_id]
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/dashboard/facility-stock-summary (facility_user) ────────────────
// Per-thematic-area stock breakdown for the user's facility.
router.get(
  '/facility-stock-summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'facility_user' || !req.user.facility_id) {
      throw forbidden('Endpoint is for facility users only');
    }

    const result = await pool.query(
      `SELECT
         ta.id   AS thematic_area_id,
         ta.name AS thematic_area_name,
         ta.code AS thematic_area_code,
         COUNT(fs.tool_id)::int                                   AS tools_on_record,
         COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int   AS tools_with_stock,
         COALESCE(SUM(fs.quantity), 0)::int                       AS total_quantity
       FROM thematic_areas ta
       LEFT JOIN tools t ON t.thematic_area_id = ta.id AND t.is_active = TRUE
       LEFT JOIN facility_stock fs ON fs.tool_id = t.id AND fs.facility_id = $1
       GROUP BY ta.id, ta.name, ta.code, ta.sort_order
       ORDER BY ta.sort_order`,
      [req.user.facility_id]
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/dashboard/recent ─────────────────────────────────────────────────
// Last 10 movements across all facilities — for the activity feed.
router.get(
  '/recent',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stateId } = dashboardStateScope(req);
    const result = await pool.query(
      `SELECT
         m.id,
         m.movement_type,
         m.quantity,
         m.reference_no,
         m.note,
         m.performed_at,
         f.id   AS facility_id,
         f.name AS facility_name,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         u.full_name AS performed_by_name
       FROM stock_movements m
       JOIN facilities     f  ON f.id  = m.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = m.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = m.performed_by
       WHERE ($1::int IS NULL OR l.state_id = $1)
       ORDER BY m.performed_at DESC
       LIMIT 10`,
      [stateId]
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/stock/coverage ───────────────────────────────────────────────────
// Per-facility stock summary for the dashboard matrix.
// Returns one row per facility with: total tools with stock > 0,
// total quantity held, and a breakdown by thematic area.
router.get(
  '/coverage',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stateId } = dashboardStateScope(req);

    // Summary row per facility (state-scoped)
    const facilitySummary = await pool.query(
      `SELECT
         f.id                                      AS facility_id,
         f.name                                    AS facility_name,
         l.name                                    AS lga_name,
         COUNT(fs.tool_id)::int                    AS tools_on_record,
         COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_with_stock,
         COALESCE(SUM(fs.quantity), 0)::int        AS total_quantity,
         MAX(fs.last_movement_at)                  AS last_movement_at
       FROM facilities f
       JOIN lgas l ON l.id = f.lga_id
       LEFT JOIN facility_stock fs ON fs.facility_id = f.id
       WHERE f.is_active = TRUE AND ($1::int IS NULL OR l.state_id = $1)
       GROUP BY f.id, f.name, l.name
       ORDER BY l.name, f.name`,
      [stateId]
    );

    // Thematic-area breakdown per facility (for the matrix colour coding)
    const thematicBreakdown = await pool.query(
      `SELECT
         fs.facility_id,
         ta.id                                          AS thematic_area_id,
         ta.name                                        AS thematic_area_name,
         ta.code                                        AS thematic_area_code,
         COUNT(fs.tool_id)::int                         AS tools_on_record,
         COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_with_stock,
         COALESCE(SUM(fs.quantity), 0)::int             AS total_quantity
       FROM facility_stock fs
       JOIN facilities     f  ON f.id  = fs.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE ($1::int IS NULL OR l.state_id = $1)
       GROUP BY fs.facility_id, ta.id, ta.name, ta.code, ta.sort_order
       ORDER BY fs.facility_id, ta.sort_order`,
      [stateId]
    );

    // Group thematic breakdown by facility_id for easy frontend lookup
    const byFacility = {};
    for (const row of thematicBreakdown.rows) {
      if (!byFacility[row.facility_id]) byFacility[row.facility_id] = [];
      byFacility[row.facility_id].push({
        thematic_area_id:   row.thematic_area_id,
        thematic_area_name: row.thematic_area_name,
        thematic_area_code: row.thematic_area_code,
        tools_on_record:    row.tools_on_record,
        tools_with_stock:   row.tools_with_stock,
        total_quantity:     row.total_quantity,
      });
    }

    const data = facilitySummary.rows.map((f) => ({
      ...f,
      thematic_areas: byFacility[f.facility_id] ?? [],
    }));

    res.json({ data });
  })
);

// ── GET /api/dashboard/low-stock ─────────────────────────────────────────────
// All facility-tool combos whose current quantity is below the applicable threshold.
// Facility-specific threshold takes priority over the global one.
router.get(
  '/low-stock',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stateId } = dashboardStateScope(req);
    const result = await pool.query(
      `SELECT
         fs.facility_id,
         f.name  AS facility_name,
         l.name  AS lga_name,
         fs.tool_id,
         t.name  AS tool_name,
         ta.name AS thematic_area_name,
         fs.quantity,
         COALESCE(
           (SELECT min_quantity FROM tool_thresholds
            WHERE tool_id = fs.tool_id AND facility_id = fs.facility_id LIMIT 1),
           (SELECT min_quantity FROM tool_thresholds
            WHERE tool_id = fs.tool_id AND facility_id IS NULL LIMIT 1)
         ) AS min_quantity
       FROM facility_stock fs
       JOIN facilities     f  ON f.id  = fs.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE ($1::int IS NULL OR l.state_id = $1)
       AND (
         EXISTS (SELECT 1 FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id = fs.facility_id)
         OR EXISTS (SELECT 1 FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id IS NULL)
       )
       AND fs.quantity < COALESCE(
         (SELECT min_quantity FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id = fs.facility_id LIMIT 1),
         (SELECT min_quantity FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id IS NULL LIMIT 1),
         0
       )
       ORDER BY fs.quantity ASC, f.name`,
      [stateId]
    );

    res.json({ data: result.rows });
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// HQ (super_admin) drill-down dashboard: States → LGAs → Facilities
// ═══════════════════════════════════════════════════════════════════════════

const { requireRole } = require('../middleware/auth');
const onlySuper = [requireAuth, requireRole('super_admin')];

// ── GET /api/dashboard/hq-kpis ────────────────────────────────────────────────
router.get(
  '/hq-kpis',
  ...onlySuper,
  asyncHandler(async (req, res) => {
    const [tools, states, facilities, hqThisMonth, distributed] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM tools WHERE is_active = TRUE`),
      pool.query(`SELECT COUNT(*) FROM states`),
      pool.query(`SELECT COUNT(*) FROM facilities WHERE is_active = TRUE`),
      pool.query(`SELECT COUNT(*) FROM state_movements WHERE performed_at >= date_trunc('month', NOW())`),
      pool.query(`SELECT COALESCE(SUM(quantity), 0) AS n FROM state_stock`),
    ]);
    res.json({
      data: {
        total_tools:           parseInt(tools.rows[0].count, 10),
        total_states:          parseInt(states.rows[0].count, 10),
        total_facilities:      parseInt(facilities.rows[0].count, 10),
        hq_movements_month:    parseInt(hqThisMonth.rows[0].count, 10),
        total_distributed:     parseInt(distributed.rows[0].n, 10),
      },
    });
  })
);

// ── GET /api/dashboard/hq-coverage?level=states|lgas|facilities ──────────────
// level=states                        → one row per state
// level=lgas&state_id=X               → one row per LGA in that state
// level=facilities&lga_id=Y           → one row per facility in that LGA
router.get(
  '/hq-coverage',
  ...onlySuper,
  asyncHandler(async (req, res) => {
    const level = req.query.level || 'states';

    if (level === 'states') {
      const result = await pool.query(
        `SELECT
           s.id   AS state_id,
           s.name AS state_name,
           COALESCE(hq.hq_qty, 0)::int                                    AS hq_sent_qty,
           COUNT(DISTINCT f.id)::int                                      AS facility_count,
           COUNT(DISTINCT fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_stocked,
           COALESCE(SUM(fs.quantity), 0)::int                             AS facility_qty,
           MAX(fs.last_movement_at)                                       AS last_movement_at
         FROM states s
         LEFT JOIN lgas l        ON l.state_id    = s.id
         LEFT JOIN facilities f  ON f.lga_id      = l.id AND f.is_active = TRUE
         LEFT JOIN facility_stock fs ON fs.facility_id = f.id
         LEFT JOIN (SELECT state_id, SUM(quantity) AS hq_qty FROM state_stock GROUP BY state_id) hq
                ON hq.state_id = s.id
         GROUP BY s.id, s.name, hq.hq_qty
         ORDER BY s.name`
      );
      return res.json({ level, data: result.rows });
    }

    if (level === 'lgas') {
      const stateId = parseInt(req.query.state_id, 10);
      if (!stateId) throw forbidden('state_id is required for level=lgas');
      const [stateRow, result] = await Promise.all([
        pool.query('SELECT id, name FROM states WHERE id = $1', [stateId]),
        pool.query(
          `SELECT
             l.id   AS lga_id,
             l.name AS lga_name,
             COUNT(DISTINCT f.id)::int                                      AS facility_count,
             COUNT(DISTINCT fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_stocked,
             COALESCE(SUM(fs.quantity), 0)::int                             AS facility_qty,
             MAX(fs.last_movement_at)                                       AS last_movement_at
           FROM lgas l
           LEFT JOIN facilities f      ON f.lga_id      = l.id AND f.is_active = TRUE
           LEFT JOIN facility_stock fs ON fs.facility_id = f.id
           WHERE l.state_id = $1
           GROUP BY l.id, l.name
           ORDER BY l.name`,
          [stateId]
        ),
      ]);
      return res.json({ level, parent: stateRow.rows[0] ?? null, data: result.rows });
    }

    if (level === 'facilities') {
      const lgaId = parseInt(req.query.lga_id, 10);
      if (!lgaId) throw forbidden('lga_id is required for level=facilities');
      const [lgaRow, result] = await Promise.all([
        pool.query(
          `SELECT l.id, l.name, s.name AS state_name
           FROM lgas l JOIN states s ON s.id = l.state_id WHERE l.id = $1`,
          [lgaId]
        ),
        pool.query(
          `SELECT
             f.id   AS facility_id,
             f.name AS facility_name,
             COUNT(fs.tool_id)::int                                        AS tools_on_record,
             COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int         AS tools_stocked,
             COALESCE(SUM(fs.quantity), 0)::int                            AS facility_qty,
             MAX(fs.last_movement_at)                                      AS last_movement_at
           FROM facilities f
           LEFT JOIN facility_stock fs ON fs.facility_id = f.id
           WHERE f.lga_id = $1 AND f.is_active = TRUE
           GROUP BY f.id, f.name
           ORDER BY f.name`,
          [lgaId]
        ),
      ]);
      return res.json({ level, parent: lgaRow.rows[0] ?? null, data: result.rows });
    }

    throw forbidden('Invalid level. Use states, lgas, or facilities.');
  })
);

module.exports = router;
