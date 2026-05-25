const express  = require('express');
const ExcelJS  = require('exceljs');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { badRequest } = require('../utils/errors');

const router = express.Router();

// Adds an access-scope condition to `conditions` (and binds to `params`).
// Returns true if the caller's role enforced a scope (so a caller-supplied
// facility_id query param should be ignored).
function applyAccessScope(req, conditions, params, columnRef) {
  if (req.user.role === 'facility_user') {
    if (!req.user.facility_id) throw badRequest('Facility user has no facility assigned');
    params.push(req.user.facility_id);
    conditions.push(`${columnRef} = $${params.length}`);
    return true;
  }
  if (req.user.role === 'dso') {
    if (!req.user.lga_id) throw badRequest('DSO has no LGA assigned');
    params.push(req.user.lga_id);
    conditions.push(`${columnRef} IN (SELECT id FROM facilities WHERE lga_id = $${params.length})`);
    return true;
  }
  return false;
}

// ── Styling helpers ───────────────────────────────────────────────────────────
const HEADER_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14532D' } };
const HEADER_FONT  = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const HEADER_ALIGN = { vertical: 'middle', horizontal: 'left' };

function styleHeader(sheet) {
  sheet.getRow(1).height = 22;
  sheet.getRow(1).eachCell((cell) => {
    cell.fill      = HEADER_FILL;
    cell.font      = HEADER_FONT;
    cell.alignment = HEADER_ALIGN;
  });
}

function sendExcel(res, workbook, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return workbook.xlsx.write(res).then(() => res.end());
}

// ── GET /api/reports/movements ────────────────────────────────────────────────
// Accepts same filters as GET /api/movements — produces a full .xlsx download.
router.get(
  '/movements',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, type, from, to } = req.query;
    const conditions = [];
    const params = [];

    // Auto-scope for facility_user / dso. Other roles may pass facility_id.
    const scoped = applyAccessScope(req, conditions, params, 'm.facility_id');
    if (!scoped && facility_id) {
      params.push(facility_id);
      conditions.push(`m.facility_id = $${params.length}`);
    }
    if (tool_id) { params.push(tool_id); conditions.push(`m.tool_id = $${params.length}`); }
    if (type)    { params.push(type);    conditions.push(`m.movement_type = $${params.length}`); }
    if (from)    { params.push(from);    conditions.push(`m.performed_at >= $${params.length}`); }
    if (to)      { params.push(to);      conditions.push(`m.performed_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
         m.id, m.movement_type, m.quantity, m.reference_no, m.reason, m.note,
         m.performed_at,
         f.name AS facility_name,
         l.name AS lga_name,
         t.name AS tool_name,
         ta.name AS thematic_area_name,
         rf.name AS related_facility_name,
         u.full_name AS performed_by
       FROM stock_movements m
       JOIN facilities     f  ON f.id  = m.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = m.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN facilities rf ON rf.id = m.related_facility_id
       LEFT JOIN users      u  ON u.id  = m.performed_by
       ${where}
       ORDER BY m.performed_at DESC`,
      params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'MER Tools';
    const ws = wb.addWorksheet('Movements');

    ws.columns = [
      { header: 'ID',               key: 'id',                    width: 8 },
      { header: 'Date / Time',      key: 'performed_at',          width: 22 },
      { header: 'Type',             key: 'movement_type',         width: 22 },
      { header: 'Facility',         key: 'facility_name',         width: 32 },
      { header: 'LGA',              key: 'lga_name',              width: 18 },
      { header: 'Tool',             key: 'tool_name',             width: 42 },
      { header: 'Thematic Area',    key: 'thematic_area_name',    width: 20 },
      { header: 'Quantity',         key: 'quantity',              width: 10 },
      { header: 'Reference No',     key: 'reference_no',          width: 16 },
      { header: 'Reason',           key: 'reason',                width: 22 },
      { header: 'Note',             key: 'note',                  width: 30 },
      { header: 'Related Facility', key: 'related_facility_name', width: 25 },
      { header: 'Performed By',     key: 'performed_by',          width: 22 },
    ];

    for (const row of result.rows) {
      ws.addRow({
        ...row,
        performed_at:  row.performed_at ? new Date(row.performed_at).toLocaleString('en-GB') : '',
        movement_type: row.movement_type?.replace(/_/g, ' ') ?? '',
        reference_no:  row.reference_no ?? '',
        reason:        row.reason ?? '',
        note:          row.note ?? '',
        related_facility_name: row.related_facility_name ?? '',
        performed_by:  row.performed_by ?? '',
      });
    }

    styleHeader(ws);
    ws.autoFilter = { from: 'A1', to: 'M1' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    await sendExcel(res, wb, `movements-${new Date().toISOString().slice(0, 10)}.xlsx`);
  })
);

// ── GET /api/reports/facility-stock ──────────────────────────────────────────
// Full stock snapshot for one or all facilities.
router.get(
  '/facility-stock',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { facility_id } = req.query;
    const conditions = [];
    const params = [];

    const scoped = applyAccessScope(req, conditions, params, 'fs.facility_id');
    if (!scoped && facility_id) {
      params.push(facility_id);
      conditions.push(`fs.facility_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT
         f.name  AS facility_name,
         l.name  AS lga_name,
         ta.name AS thematic_area,
         t.name  AS tool_name,
         t.status AS tool_status,
         fs.quantity,
         fs.last_movement_at
       FROM facility_stock fs
       JOIN facilities     f  ON f.id  = fs.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = fs.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       ${where}
       ORDER BY l.name, f.name, ta.sort_order, t.name`,
      params
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'MER Tools';
    const ws = wb.addWorksheet('Facility Stock');

    ws.columns = [
      { header: 'Facility',         key: 'facility_name',    width: 32 },
      { header: 'LGA',              key: 'lga_name',         width: 18 },
      { header: 'Thematic Area',    key: 'thematic_area',    width: 20 },
      { header: 'Tool',             key: 'tool_name',        width: 42 },
      { header: 'Status',           key: 'tool_status',      width: 16 },
      { header: 'Quantity',         key: 'quantity',         width: 10 },
      { header: 'Last Movement',    key: 'last_movement_at', width: 22 },
    ];

    for (const row of result.rows) {
      ws.addRow({
        ...row,
        tool_status:      row.tool_status?.replace('_', ' / ') ?? '',
        last_movement_at: row.last_movement_at ? new Date(row.last_movement_at).toLocaleString('en-GB') : '—',
      });

      // Colour zero-stock cells red
      const lastRow = ws.lastRow;
      if (row.quantity === 0) {
        lastRow.getCell('quantity').font = { color: { argb: 'FFB91C1C' }, bold: true };
      }
    }

    styleHeader(ws);
    ws.autoFilter = { from: 'A1', to: 'G1' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    await sendExcel(res, wb, `facility-stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
  })
);

// ── GET /api/reports/coverage-pivot ──────────────────────────────────────────
// LGA × Thematic Area pivot — total qty per cell.
router.get(
  '/coverage-pivot',
  requireAuth,
  asyncHandler(async (req, res) => {
    const areasResult = await pool.query(
      'SELECT id, name, code FROM thematic_areas ORDER BY sort_order'
    );
    const areas = areasResult.rows;

    const conditions = ['f.is_active = TRUE'];
    const params = [];
    applyAccessScope(req, conditions, params, 'f.id');
    const where = `WHERE ${conditions.join(' AND ')}`;

    const pivotResult = await pool.query(
      `SELECT
         l.name  AS lga_name,
         f.name  AS facility_name,
         ta.id   AS thematic_area_id,
         COALESCE(SUM(fs.quantity), 0)::int AS total_qty,
         COUNT(fs.tool_id) FILTER (WHERE fs.quantity > 0)::int AS tools_with_stock
       FROM facilities f
       JOIN lgas           l  ON l.id  = f.lga_id
       CROSS JOIN thematic_areas ta
       LEFT JOIN tools t ON t.thematic_area_id = ta.id AND t.is_active = TRUE
       LEFT JOIN facility_stock fs ON fs.facility_id = f.id AND fs.tool_id = t.id
       ${where}
       GROUP BY l.name, f.name, ta.id, ta.sort_order
       ORDER BY l.name, f.name, ta.sort_order`,
      params
    );

    // Build pivot map: { "LGA|Facility" -> { thematic_area_id -> { total_qty, tools_with_stock } } }
    const pivot = new Map();
    for (const row of pivotResult.rows) {
      const key = `${row.lga_name}|${row.facility_name}`;
      if (!pivot.has(key)) pivot.set(key, { lga: row.lga_name, facility: row.facility_name, areas: {} });
      pivot.get(key).areas[row.thematic_area_id] = {
        qty:   row.total_qty,
        tools: row.tools_with_stock,
      };
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'MER Tools';
    const ws = wb.addWorksheet('Coverage Pivot');

    // Build column defs: LGA | Facility | one col per thematic area (qty)
    ws.columns = [
      { header: 'LGA',      key: 'lga',      width: 18 },
      { header: 'Facility', key: 'facility', width: 32 },
      ...areas.map((a) => ({ header: a.code, key: `area_${a.id}`, width: 12 })),
      { header: 'Total', key: 'total', width: 10 },
    ];

    for (const entry of pivot.values()) {
      const rowData = { lga: entry.lga, facility: entry.facility };
      let total = 0;
      for (const a of areas) {
        const val = entry.areas[a.id]?.qty ?? 0;
        rowData[`area_${a.id}`] = val;
        total += val;
      }
      rowData.total = total;

      ws.addRow(rowData);

      // Colour zero cells in area columns light red
      const lastRow = ws.lastRow;
      areas.forEach((a, i) => {
        const cell = lastRow.getCell(i + 3); // +3 because LGA, Facility are cols 1-2
        if ((entry.areas[a.id]?.qty ?? 0) === 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
        }
      });
    }

    styleHeader(ws);
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];

    await sendExcel(res, wb, `coverage-pivot-${new Date().toISOString().slice(0, 10)}.xlsx`);
  })
);

// ── GET /api/reports/usage ───────────────────────────────────────────────────
// Tools Tracker workbook — TWO worksheets in the same file:
//   1. "Weekly summary" — one row per (facility, tool, week) with the full
//      balance breakdown (Beginning / Supplied / Utilized / Adj± / Ending).
//      Utilized is the SUM of all daily entries within the week.
//   2. "Daily detail"   — one row per day for audit purposes.
// Filters: ?facility_id, ?tool_id, ?from, ?to  (interpreted as dates).
router.get(
  '/usage',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { facility_id, tool_id, from, to } = req.query;

    // ── Filter scaffolding shared between both sheets ──
    // For the weekly sheet, the per_key CTE is filtered by pk.* references.
    // For the daily sheet, we filter by tu.* directly.
    const weeklyConds = [];
    const weeklyParams = [];
    const weeklyScoped = applyAccessScope(req, weeklyConds, weeklyParams, 'pk.facility_id');
    if (!weeklyScoped && facility_id) {
      weeklyParams.push(facility_id);
      weeklyConds.push(`pk.facility_id = $${weeklyParams.length}`);
    }
    if (tool_id) { weeklyParams.push(tool_id); weeklyConds.push(`pk.tool_id = $${weeklyParams.length}`); }
    if (from)    { weeklyParams.push(from);    weeklyConds.push(`pk.week_start >= $${weeklyParams.length}::date`); }
    if (to)      { weeklyParams.push(to);      weeklyConds.push(`pk.week_start <= $${weeklyParams.length}::date`); }
    const weeklyWhere = weeklyConds.length ? `WHERE ${weeklyConds.join(' AND ')}` : '';

    const dailyConds = [];
    const dailyParams = [];
    const dailyScoped = applyAccessScope(req, dailyConds, dailyParams, 'tu.facility_id');
    if (!dailyScoped && facility_id) {
      dailyParams.push(facility_id);
      dailyConds.push(`tu.facility_id = $${dailyParams.length}`);
    }
    if (tool_id) { dailyParams.push(tool_id); dailyConds.push(`tu.tool_id = $${dailyParams.length}`); }
    if (from)    { dailyParams.push(from);    dailyConds.push(`tu.usage_date >= $${dailyParams.length}::date`); }
    if (to)      { dailyParams.push(to);      dailyConds.push(`tu.usage_date <= $${dailyParams.length}::date`); }
    const dailyWhere = dailyConds.length ? `WHERE ${dailyConds.join(' AND ')}` : '';

    // ── Weekly summary query ───────────────────────────────────────────────
    // Movements bucket by date_trunc('week', performed_at).
    // Usage    bucket by date_trunc('week', usage_date).
    // The per_key CTE covers every (facility, tool, week) that had any
    // activity, with a window-function computed beginning_balance.
    const weeklyResult = await pool.query(
      `WITH
       activity_keys AS (
         SELECT facility_id, tool_id,
                date_trunc('week', usage_date)::date AS week_start
         FROM tool_usage
         UNION
         SELECT facility_id, tool_id,
                date_trunc('week', performed_at)::date AS week_start
         FROM stock_movements
       ),
       weekly_movements AS (
         SELECT
           facility_id, tool_id,
           date_trunc('week', performed_at)::date AS week_start,
           SUM(CASE WHEN movement_type = 'RECEIPT' THEN quantity ELSE 0 END)                              AS supplied,
           SUM(CASE WHEN movement_type IN ('TRANSFER_IN','ADJUSTMENT_INCREASE')  THEN quantity ELSE 0 END) AS pos_adj,
           SUM(CASE WHEN movement_type IN ('TRANSFER_OUT','ADJUSTMENT_DECREASE') THEN quantity ELSE 0 END) AS neg_adj
         FROM stock_movements
         GROUP BY facility_id, tool_id, date_trunc('week', performed_at)
       ),
       weekly_usage AS (
         SELECT
           facility_id, tool_id,
           date_trunc('week', usage_date)::date AS week_start,
           SUM(usage_count)::int                 AS utilized,
           COUNT(DISTINCT usage_date)::int       AS days_recorded
         FROM tool_usage
         GROUP BY facility_id, tool_id, date_trunc('week', usage_date)
       ),
       per_key AS (
         SELECT
           ak.facility_id,
           ak.tool_id,
           ak.week_start,
           COALESCE(wm.supplied, 0) AS supplied,
           COALESCE(wm.pos_adj,  0) AS pos_adj,
           COALESCE(wm.neg_adj,  0) AS neg_adj,
           COALESCE(wu.utilized, 0) AS utilized,
           COALESCE(wu.days_recorded, 0) AS days_recorded,
           SUM(COALESCE(wm.supplied,0) + COALESCE(wm.pos_adj,0) - COALESCE(wm.neg_adj,0) - COALESCE(wu.utilized,0))
             OVER (PARTITION BY ak.facility_id, ak.tool_id ORDER BY ak.week_start
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS beginning_balance
         FROM (SELECT DISTINCT facility_id, tool_id, week_start FROM activity_keys) ak
         LEFT JOIN weekly_movements wm
                ON wm.facility_id = ak.facility_id
               AND wm.tool_id     = ak.tool_id
               AND wm.week_start  = ak.week_start
         LEFT JOIN weekly_usage wu
                ON wu.facility_id = ak.facility_id
               AND wu.tool_id     = ak.tool_id
               AND wu.week_start  = ak.week_start
       )
       SELECT
         pk.week_start                                                              AS week_start_date,
         f.name  AS facility_name,
         l.name  AS lga_name,
         ta.name AS thematic_area,
         t.name  AS tool_name,
         GREATEST(0, COALESCE(pk.beginning_balance, 0))::int                        AS beginning_balance,
         pk.supplied::int                                                           AS quantity_supplied,
         pk.utilized::int                                                           AS quantity_utilized,
         pk.days_recorded::int                                                      AS days_recorded,
         pk.pos_adj::int                                                            AS adjustment_positive,
         pk.neg_adj::int                                                            AS adjustment_negative,
         -- Use CAPPED beginning so each row reconciles visually.
         GREATEST(0,
           GREATEST(0, COALESCE(pk.beginning_balance, 0))
           + pk.supplied + pk.pos_adj
           - pk.utilized - pk.neg_adj
         )::int                                                                     AS ending_balance
       FROM per_key pk
       JOIN facilities     f  ON f.id  = pk.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = pk.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       ${weeklyWhere}
       ORDER BY pk.week_start DESC, l.name, f.name, ta.sort_order, t.name`,
      weeklyParams
    );

    // ── Daily detail query ─────────────────────────────────────────────────
    const dailyResult = await pool.query(
      `SELECT
         tu.usage_date,
         f.name  AS facility_name,
         l.name  AS lga_name,
         ta.name AS thematic_area,
         t.name  AS tool_name,
         tu.usage_count,
         tu.note,
         u.full_name AS recorded_by,
         tu.recorded_at,
         tu.updated_at
       FROM tool_usage tu
       JOIN facilities     f  ON f.id  = tu.facility_id
       JOIN lgas           l  ON l.id  = f.lga_id
       JOIN tools          t  ON t.id  = tu.tool_id
       JOIN thematic_areas ta ON ta.id = t.thematic_area_id
       LEFT JOIN users     u  ON u.id  = tu.recorded_by
       ${dailyWhere}
       ORDER BY tu.usage_date DESC, l.name, f.name, ta.sort_order, t.name`,
      dailyParams
    );

    // ── Build the workbook with two worksheets ─────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MER Tools';

    // 1. Weekly summary
    const wsWeekly = wb.addWorksheet('Weekly summary');
    wsWeekly.columns = [
      { header: 'Week start',          key: 'week_start_date',     width: 12 },
      { header: 'Facility',            key: 'facility_name',       width: 30 },
      { header: 'LGA',                 key: 'lga_name',            width: 16 },
      { header: 'Thematic area',       key: 'thematic_area',       width: 18 },
      { header: 'Tool',                key: 'tool_name',           width: 38 },
      { header: 'Beginning Balance',   key: 'beginning_balance',   width: 16 },
      { header: 'Quantity Supplied',   key: 'quantity_supplied',   width: 16 },
      { header: 'Quantity Utilized',   key: 'quantity_utilized',   width: 16 },
      { header: 'Days recorded',       key: 'days_recorded',       width: 14 },
      { header: 'Adjustment +',        key: 'adjustment_positive', width: 14 },
      { header: 'Adjustment −',        key: 'adjustment_negative', width: 14 },
      { header: 'Ending Balance',      key: 'ending_balance',      width: 14 },
    ];
    for (const row of weeklyResult.rows) {
      wsWeekly.addRow({
        ...row,
        week_start_date: row.week_start_date
          ? new Date(row.week_start_date).toISOString().slice(0, 10)
          : '',
      });
    }
    styleHeader(wsWeekly);
    wsWeekly.autoFilter = { from: 'A1', to: 'L1' };
    wsWeekly.views = [{ state: 'frozen', ySplit: 1, xSplit: 5 }];

    // 2. Daily detail
    const wsDaily = wb.addWorksheet('Daily detail');
    wsDaily.columns = [
      { header: 'Date',          key: 'usage_date',     width: 12 },
      { header: 'Facility',      key: 'facility_name',  width: 30 },
      { header: 'LGA',           key: 'lga_name',       width: 16 },
      { header: 'Thematic area', key: 'thematic_area',  width: 18 },
      { header: 'Tool',          key: 'tool_name',      width: 38 },
      { header: 'Usage count',   key: 'usage_count',    width: 14 },
      { header: 'Note',          key: 'note',           width: 28 },
      { header: 'Recorded by',   key: 'recorded_by',    width: 22 },
      { header: 'Recorded at',   key: 'recorded_at',    width: 20 },
    ];
    for (const row of dailyResult.rows) {
      wsDaily.addRow({
        ...row,
        usage_date:  row.usage_date  ? new Date(row.usage_date).toISOString().slice(0, 10) : '',
        note:        row.note ?? '',
        recorded_by: row.recorded_by ?? '',
        recorded_at: row.recorded_at ? new Date(row.recorded_at).toISOString().slice(0, 19).replace('T', ' ') : '',
      });
    }
    styleHeader(wsDaily);
    wsDaily.autoFilter = { from: 'A1', to: 'I1' };
    wsDaily.views = [{ state: 'frozen', ySplit: 1, xSplit: 5 }];

    await sendExcel(res, wb, `tools-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`);
  })
);

module.exports = router;
