const express = require('express');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { forbidden } = require('../utils/errors');

const router = express.Router();

// ── GET /api/dashboard/kpis (admin / central / viewer) ───────────────────────
router.get(
  '/kpis',
  requireAuth,
  asyncHandler(async (req, res) => {
    const [tools, facilities, movementsThisMonth, zeroStock, openDisputes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM tools WHERE is_active = TRUE`),
      pool.query(`SELECT COUNT(*) FROM facilities WHERE is_active = TRUE`),
      pool.query(
        `SELECT COUNT(*) FROM stock_movements
         WHERE performed_at >= date_trunc('month', NOW())`
      ),
      pool.query(
        `SELECT COUNT(DISTINCT facility_id) FROM facility_stock WHERE quantity = 0`
      ),
      pool.query(
        `SELECT COUNT(*) FROM stock_movements
         WHERE ack_status = 'DISPUTED' AND dispute_resolved_at IS NULL`
      ),
    ]);

    res.json({
      data: {
        total_tools:           parseInt(tools.rows[0].count, 10),
        total_facilities:      parseInt(facilities.rows[0].count, 10),
        movements_this_month:  parseInt(movementsThisMonth.rows[0].count, 10),
        facilities_zero_stock: parseInt(zeroStock.rows[0].count, 10),
        open_disputes:         parseInt(openDisputes.rows[0].count, 10),
      },
    });
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
       JOIN tools          t  ON t.id  = m.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = m.performed_by
       ORDER BY m.performed_at DESC
       LIMIT 10`
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
    // Summary row per facility
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
       WHERE f.is_active = TRUE
       GROUP BY f.id, f.name, l.name
       ORDER BY l.name, f.name`
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
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       GROUP BY fs.facility_id, ta.id, ta.name, ta.code
       ORDER BY fs.facility_id, ta.sort_order`
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
       WHERE (
         EXISTS (SELECT 1 FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id = fs.facility_id)
         OR EXISTS (SELECT 1 FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id IS NULL)
       )
       AND fs.quantity < COALESCE(
         (SELECT min_quantity FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id = fs.facility_id LIMIT 1),
         (SELECT min_quantity FROM tool_thresholds WHERE tool_id = fs.tool_id AND facility_id IS NULL LIMIT 1),
         0
       )
       ORDER BY fs.quantity ASC, f.name`
    );

    res.json({ data: result.rows });
  })
);

module.exports = router;
