const express = require('express');
const { z }   = require('zod');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { badRequest, forbidden } = require('../utils/errors');
const { applyFacilityScope } = require('../middleware/scope');
const { recordDailyUsage } = require('../services/usageService');

const router = express.Router();

const BACK_DATING_DAYS = 14;

// Validates a YYYY-MM-DD string is a real date, not in the future,
// and not more than BACK_DATING_DAYS days in the past.
function assertValidUsageDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw badRequest('Format YYYY-MM-DD required');
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw badRequest('Invalid usage_date');

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (d > today) throw badRequest('usage_date cannot be in the future');

  const minDate = new Date(today);
  minDate.setUTCDate(minDate.getUTCDate() - BACK_DATING_DAYS);
  if (d < minDate) {
    throw badRequest(`usage_date cannot be more than ${BACK_DATING_DAYS} days in the past`);
  }
}

// Validate "YYYY-MM-DD" and require it to be a Monday (used by tracker + week views).
function assertMondayWeekStart(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw badRequest('Format YYYY-MM-DD required');
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw badRequest('Invalid week_start_date');
  if (d.getUTCDay() !== 1) throw badRequest('week_start_date must be a Monday (YYYY-MM-DD)');
}

// Scope helper — shared facility scope on tu.facility_id.
const applyAccessScope = (req, conditions, params, columnRef = 'tu.facility_id') =>
  applyFacilityScope(req, conditions, params, columnRef);

// Resolve the facility a non-facility_user is acting on, enforcing scope.
// facility_user → their own facility; everyone else must pass facility_id and
// have it fall within their state (admin/central/viewer) or LGA (dso).
async function resolveScopedFacility(req) {
  if (req.user.role === 'facility_user') return req.user.facility_id;

  const facilityId = parseInt(req.query.facility_id, 10);
  if (!facilityId) throw badRequest('facility_id query param is required');
  if (req.user.role === 'super_admin') return facilityId;

  const r = await pool.query(
    `SELECT f.lga_id, l.state_id FROM facilities f
     JOIN lgas l ON l.id = f.lga_id WHERE f.id = $1`,
    [facilityId]
  );
  if (r.rows.length === 0) throw forbidden('Facility not found');
  const { lga_id, state_id } = r.rows[0];

  if (req.user.role === 'dso' && lga_id !== req.user.lga_id) {
    throw forbidden('Facility is outside your LGA');
  }
  if (['admin', 'central_logistics', 'viewer'].includes(req.user.role)
      && req.user.effective_state_id && state_id !== req.user.effective_state_id) {
    throw forbidden('Facility is outside your state');
  }
  return facilityId;
}

// ── POST /api/usage ──────────────────────────────────────────────────────────
// Facility users (or admin) submit one or more entries for a specific date.
// Same-day re-records are additive.
const submitSchema = z.object({
  usage_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD required'),
  entries: z.array(z.object({
    tool_id:          z.number().int().positive(),
    count:            z.number().int().min(0),
    note:             z.string().trim().optional(),
    service_point_id: z.number().int().positive().optional(),
    physical_balance: z.number().int().min(0).optional(),
  })).min(1, 'At least one entry required'),
});

router.post(
  '/',
  requireAuth,
  requireRole('facility_user', 'admin'),
  validate(submitSchema),
  asyncHandler(async (req, res) => {
    const { usage_date, entries } = req.body;
    assertValidUsageDate(usage_date);

    let facilityId;
    if (req.user.role === 'facility_user') {
      facilityId = req.user.facility_id;
    } else {
      facilityId = req.body.facility_id;
      if (!facilityId) throw badRequest('Admin must supply facility_id');
    }

    const saved = await recordDailyUsage({
      facilityId,
      usageDate:  usage_date,
      entries,
      recordedBy: req.user.id,
    });

    res.status(201).json({ data: saved, count: saved.length });
  })
);

// ── GET /api/usage/week/:date ────────────────────────────────────────────────
// One row per tool, summed across the seven days starting at `:date` (Monday).
// Used for the week-summary view above the tracker.
router.get(
  '/week/:date',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { date } = req.params;
    assertMondayWeekStart(date);

    const facilityId = await resolveScopedFacility(req);

    const result = await pool.query(
      `SELECT
         tu.tool_id,
         SUM(tu.usage_count)::int                AS usage_count,
         COUNT(DISTINCT tu.usage_date)::int      AS days_recorded,
         MAX(tu.updated_at)                      AS last_updated_at,
         t.name   AS tool_name,
         t.status AS tool_status,
         ta.id    AS thematic_area_id,
         ta.name  AS thematic_area_name,
         ta.code  AS thematic_area_code,
         ta.sort_order
       FROM tool_usage tu
       JOIN tools          t  ON t.id  = tu.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       WHERE tu.facility_id = $1
         AND tu.usage_date >= $2::date
         AND tu.usage_date <  ($2::date + INTERVAL '7 days')::date
       GROUP BY tu.tool_id, t.name, t.status, ta.id, ta.name, ta.code, ta.sort_order
       ORDER BY ta.sort_order, t.name`,
      [facilityId, date]
    );

    res.json({ facility_id: facilityId, week_start_date: date, data: result.rows });
  })
);

// ── GET /api/usage/day/:date ─────────────────────────────────────────────────
// Detailed view of one day's entries for a facility — used to show
// "today's logged usage" or browse a specific day.
router.get(
  '/day/:date',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Date must be YYYY-MM-DD');

    const facilityId = await resolveScopedFacility(req);

    const result = await pool.query(
      `SELECT
         tu.id, tu.tool_id, tu.usage_count, tu.note,
         tu.recorded_at, tu.updated_at,
         t.name   AS tool_name,
         ta.name  AS thematic_area_name,
         ta.code  AS thematic_area_code,
         ta.sort_order,
         u.full_name AS recorded_by_name
       FROM tool_usage tu
       JOIN tools          t  ON t.id  = tu.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = tu.recorded_by
       WHERE tu.facility_id = $1 AND tu.usage_date = $2
       ORDER BY ta.sort_order, t.name`,
      [facilityId, date]
    );

    res.json({ facility_id: facilityId, usage_date: date, data: result.rows });
  })
);

// ── GET /api/usage ───────────────────────────────────────────────────────────
// Flat list with filters (facility_id, tool_id, from, to). One row per day.
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, from, to } = req.query;

    const conditions = [];
    const params = [];
    const scoped = applyAccessScope(req, conditions, params);
    if (!scoped && facility_id) {
      params.push(facility_id);
      conditions.push(`tu.facility_id = $${params.length}`);
    }
    if (tool_id) { params.push(tool_id); conditions.push(`tu.tool_id = $${params.length}`); }
    if (from)    { params.push(from);    conditions.push(`tu.usage_date >= $${params.length}`); }
    if (to)      { params.push(to);      conditions.push(`tu.usage_date <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
         tu.id, tu.usage_date, tu.usage_count, tu.note,
         tu.recorded_at, tu.updated_at,
         f.id   AS facility_id,
         f.name AS facility_name,
         l.name AS lga_name,
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         u.full_name AS recorded_by_name
       FROM tool_usage tu
       JOIN facilities     f  ON f.id  = tu.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = tu.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = tu.recorded_by
       ${where}
       ORDER BY tu.usage_date DESC, f.name, ta.sort_order, t.name
       LIMIT 500`,
      params
    );

    res.json({ data: result.rows });
  })
);

// ── GET /api/usage/tracker?facility_id=&week_start_date= ─────────────────────
// Tools Tracker for one facility / one week:
//   beginning_balance   — stock on hand at start of week
//   quantity_supplied   — RECEIPTs during the week
//   quantity_utilized   — SUM of daily usage entries during the week
//   adjustment_positive — TRANSFER_IN + ADJUSTMENT_INCREASE during the week
//   adjustment_negative — TRANSFER_OUT + ADJUSTMENT_DECREASE during the week
//   ending_balance      — beg + supplied + adj+ − utilized − adj−  (capped at 0)
router.get(
  '/tracker',
  requireAuth,
  asyncHandler(async (req, res) => {
    const week = req.query.week_start_date;
    assertMondayWeekStart(week);

    const facilityId = await resolveScopedFacility(req);

    const result = await pool.query(
      `WITH
       week_bounds AS (
         SELECT $2::date AS start_date, ($2::date + INTERVAL '7 days')::date AS end_excl
       ),
       tools_seen AS (
         SELECT DISTINCT tool_id FROM stock_movements WHERE facility_id = $1
         UNION
         SELECT DISTINCT tool_id FROM tool_usage      WHERE facility_id = $1
         UNION
         SELECT DISTINCT tool_id FROM facility_stock  WHERE facility_id = $1
       ),
       movements_before AS (
         -- Incoming stock (RECEIPT / TRANSFER_IN) only counts once the
         -- facility has confirmed physical receipt: full quantity when
         -- ACCEPTED, the actual received quantity when a dispute has been
         -- resolved, and nothing while still pending / in open dispute.
         SELECT
           tool_id,
           SUM(CASE
             WHEN movement_type IN ('RECEIPT','TRANSFER_IN') THEN
               CASE
                 WHEN ack_status = 'ACCEPTED' THEN quantity
                 WHEN ack_status = 'DISPUTED' AND dispute_resolved_at IS NOT NULL THEN COALESCE(disputed_quantity, 0)
                 ELSE 0
               END
             WHEN movement_type = 'ADJUSTMENT_INCREASE'                    THEN  quantity
             WHEN movement_type IN ('TRANSFER_OUT','ADJUSTMENT_DECREASE')  THEN -quantity
             ELSE 0
           END) AS net
         FROM stock_movements
         WHERE facility_id = $1
           AND performed_at < (SELECT start_date FROM week_bounds)
         GROUP BY tool_id
       ),
       usage_before AS (
         SELECT tool_id, SUM(usage_count) AS used
         FROM tool_usage
         WHERE facility_id = $1
           AND usage_date < (SELECT start_date FROM week_bounds)
         GROUP BY tool_id
       ),
       week_movements AS (
         SELECT
           tool_id,
           SUM(CASE WHEN movement_type = 'RECEIPT' THEN
             CASE
               WHEN ack_status = 'ACCEPTED' THEN quantity
               WHEN ack_status = 'DISPUTED' AND dispute_resolved_at IS NOT NULL THEN COALESCE(disputed_quantity, 0)
               ELSE 0
             END
           ELSE 0 END)                                                                                     AS supplied,
           SUM(CASE
             WHEN movement_type = 'TRANSFER_IN' THEN
               CASE
                 WHEN ack_status = 'ACCEPTED' THEN quantity
                 WHEN ack_status = 'DISPUTED' AND dispute_resolved_at IS NOT NULL THEN COALESCE(disputed_quantity, 0)
                 ELSE 0
               END
             WHEN movement_type = 'ADJUSTMENT_INCREASE' THEN quantity
             ELSE 0
           END)                                                                                            AS pos_adj,
           SUM(CASE WHEN movement_type IN ('TRANSFER_OUT','ADJUSTMENT_DECREASE') THEN quantity ELSE 0 END)  AS neg_adj
         FROM stock_movements
         WHERE facility_id = $1
           AND performed_at >= (SELECT start_date FROM week_bounds)
           AND performed_at <  (SELECT end_excl   FROM week_bounds)
         GROUP BY tool_id
       ),
       week_usage AS (
         SELECT tool_id, SUM(usage_count)::int AS usage_count
         FROM tool_usage
         WHERE facility_id = $1
           AND usage_date >= (SELECT start_date FROM week_bounds)
           AND usage_date <  (SELECT end_excl   FROM week_bounds)
         GROUP BY tool_id
       )
       SELECT
         t.id   AS tool_id,
         t.name AS tool_name,
         ta.id  AS thematic_area_id,
         ta.name AS thematic_area_name,
         ta.code AS thematic_area_code,
         ta.sort_order,
         -- Beginning is capped at 0 — historical over-recording (before the
         -- pre-save stock check was in place) won't surface as a negative.
         GREATEST(0, COALESCE(mb.net, 0) - COALESCE(ub.used, 0))::int             AS beginning_balance,
         COALESCE(wm.supplied, 0)::int                                            AS quantity_supplied,
         COALESCE(wu.usage_count, 0)::int                                         AS quantity_utilized,
         COALESCE(wm.pos_adj, 0)::int                                             AS adjustment_positive,
         COALESCE(wm.neg_adj, 0)::int                                             AS adjustment_negative,
         -- Ending uses the CAPPED beginning so the row reconciles visually:
         --   Ending = max(0, Beginning) + Supplied + Adj+ − Utilized − Adj−
         GREATEST(0,
           GREATEST(0, COALESCE(mb.net, 0) - COALESCE(ub.used, 0))
           + COALESCE(wm.supplied, 0) + COALESCE(wm.pos_adj, 0)
           - COALESCE(wu.usage_count, 0) - COALESCE(wm.neg_adj, 0)
         )::int                                                                   AS ending_balance
       FROM tools_seen ts
       JOIN tools          t  ON t.id  = ts.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN movements_before mb ON mb.tool_id = ts.tool_id
       LEFT JOIN usage_before     ub ON ub.tool_id = ts.tool_id
       LEFT JOIN week_movements   wm ON wm.tool_id = ts.tool_id
       LEFT JOIN week_usage       wu ON wu.tool_id = ts.tool_id
       WHERE t.is_active = TRUE
       ORDER BY ta.sort_order, t.name`,
      [facilityId, week]
    );

    res.json({
      facility_id: facilityId,
      week_start_date: week,
      data: result.rows,
    });
  })
);

module.exports = router;
