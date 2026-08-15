const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { pool } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { badRequest } = require('../utils/errors');

const router = express.Router();

const DEFAULT_THRESHOLD = 20;

// Brand logo shown at the top of the procurement PDF. Bundled with the backend;
// null if the file is missing so PDF generation never crashes.
const LOGO_PATH = (() => {
  const p = path.join(__dirname, '..', '..', 'assets', 'logoe.png');
  return fs.existsSync(p) ? p : null;
})();

// The state this request operates on: state admins are pinned to their own
// state; super_admin must name one via ?state_id.
async function resolveState(req) {
  let stateId;
  if (req.user.role === 'super_admin') {
    stateId = parseInt(req.query.state_id, 10);
    if (!stateId) throw badRequest('state_id is required for super admin');
  } else {
    stateId = req.user.effective_state_id;
    if (!stateId) throw badRequest('User has no state context');
  }
  const r = await pool.query('SELECT id, name FROM states WHERE id = $1', [stateId]);
  if (r.rows.length === 0) throw badRequest('State not found');
  return r.rows[0];
}

function resolveThreshold(req) {
  const t = parseInt(req.query.threshold, 10);
  if (Number.isInteger(t) && t >= 0 && t <= 100000) return t;
  return DEFAULT_THRESHOLD;
}

// Tools whose STATE balance left is at/below the threshold — i.e. reorder-from-HQ
// candidates. "State balance" here is the SAME number the State inventory page
// shows: what HQ has sent the state (state_stock) minus what the state has
// already distributed to its facilities. This is the state's own distributable
// stock, not the facility-held total. Only tools HQ has actually sent to the
// state are considered.
async function lowToolsForState(stateId, threshold) {
  const result = await pool.query(
    `WITH state_facilities AS (
       SELECT f.id FROM facilities f JOIN lgas l ON l.id = f.lga_id
       WHERE l.state_id = $1 AND f.is_active = TRUE
     ),
     hq_totals AS (
       SELECT tool_id, SUM(quantity)::int AS hq_sent
       FROM state_stock WHERE state_id = $1 GROUP BY tool_id
     ),
     distributed AS (
       -- Everything the state office has pushed to its facilities (regardless
       -- of facility acknowledgement — it has left the state office).
       SELECT m.tool_id, SUM(m.quantity)::int AS sent_out
       FROM stock_movements m
       WHERE m.movement_type = 'RECEIPT'
         AND m.facility_id IN (SELECT id FROM state_facilities)
       GROUP BY m.tool_id
     ),
     facility_totals AS (
       SELECT fs.tool_id,
              COUNT(*) FILTER (WHERE fs.quantity > 0)::int AS facilities_holding
       FROM facility_stock fs
       WHERE fs.facility_id IN (SELECT id FROM state_facilities)
       GROUP BY fs.tool_id
     )
     SELECT
       t.id    AS tool_id,
       t.name  AS tool_name,
       ta.id   AS thematic_area_id,
       ta.name AS thematic_area_name,
       ta.sort_order,
       -- State balance left = received from HQ − distributed to facilities.
       -- Matches the State inventory page exactly.
       GREATEST(0, COALESCE(hq.hq_sent, 0) - COALESCE(d.sent_out, 0)) AS state_total,
       COALESCE(ft.facilities_holding, 0) AS facilities_holding,
       COALESCE(hq.hq_sent, 0)            AS hq_sent_total
     FROM tools t
     JOIN thematic_areas ta ON ta.id = t.thematic_area_id
     LEFT JOIN hq_totals       hq ON hq.tool_id = t.id
     LEFT JOIN distributed     d  ON d.tool_id  = t.id
     LEFT JOIN facility_totals ft ON ft.tool_id = t.id
     WHERE t.is_active = TRUE
       AND hq.tool_id IS NOT NULL   -- only tools HQ has sent to this state
       AND GREATEST(0, COALESCE(hq.hq_sent, 0) - COALESCE(d.sent_out, 0)) <= $2
     ORDER BY ta.sort_order,
              GREATEST(0, COALESCE(hq.hq_sent, 0) - COALESCE(d.sent_out, 0)) ASC,
              t.name`,
    [stateId, threshold]
  );
  return result.rows;
}

// ── GET /api/procurement/low-tools ────────────────────────────────────────────
// The module data: flagged tools grouped-ready by thematic area.
router.get(
  '/low-tools',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const state = await resolveState(req);
    const threshold = resolveThreshold(req);
    const rows = await lowToolsForState(state.id, threshold);
    res.json({ state, threshold, count: rows.length, data: rows });
  })
);

// ── GET /api/procurement/low-tools/pdf ────────────────────────────────────────
// Printable procurement request — grouped by thematic area, for emailing HQ.
router.get(
  '/low-tools/pdf',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const state = await resolveState(req);
    const threshold = resolveThreshold(req);
    const rows = await lowToolsForState(state.id, threshold);

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const filename = `procurement-request-${state.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Header — brand logo (if bundled), then the title beneath it.
    const headTop = doc.y;
    if (LOGO_PATH) {
      try { doc.image(LOGO_PATH, left, headTop, { height: 34 }); } catch { /* skip a bad image */ }
      doc.y = headTop + 42;
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#14532D')
      .text('Tool Procurement Request', left, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor('#64748B')
      .text(`Tools whose state balance left (received from HQ − distributed to facilities) is at or below the re-order level (${threshold}). Prepared for the HQ team.`);
    doc.moveDown(0.8);

    // Meta
    doc.fillColor('#0F172A').fontSize(10);
    const metaTop = doc.y;
    const col2x = left + width / 2;
    doc.font('Helvetica-Bold').text('State:', left, metaTop);
    doc.font('Helvetica').text(state.name, left + 100, metaTop);
    doc.font('Helvetica-Bold').text('Date:', col2x, metaTop);
    doc.font('Helvetica').text(dateStr, col2x + 60, metaTop);
    const metaRow2 = doc.y + 4;
    doc.font('Helvetica-Bold').text('Prepared by:', left, metaRow2);
    doc.font('Helvetica').text(req.user.full_name, left + 100, metaRow2);
    doc.font('Helvetica-Bold').text('Tools flagged:', col2x, metaRow2);
    doc.font('Helvetica').text(String(rows.length), col2x + 90, metaRow2);
    doc.moveDown(1.2);

    if (rows.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor('#0F172A')
        .text('No tools are at or below the re-order level. No procurement action required.');
    }

    // Grouped tables by thematic area
    const qty1X = right - 200; // state balance
    const qty2X = right - 100; // HQ sent to date
    let currentArea = null;

    const ensureSpace = (needed) => {
      if (doc.y > doc.page.height - needed) { doc.addPage(); }
    };

    for (const row of rows) {
      if (row.thematic_area_name !== currentArea) {
        currentArea = row.thematic_area_name;
        ensureSpace(150);
        doc.moveDown(0.6);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#14532D').text(currentArea, left, doc.y);
        doc.moveDown(0.3);
        const headTop = doc.y;
        doc.rect(left, headTop, width, 18).fill('#14532D');
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
        doc.text('Tool', left + 8, headTop + 5);
        doc.text('Balance left', qty1X, headTop + 5, { width: 90, align: 'right' });
        doc.text('HQ sent to date', qty2X, headTop + 5, { width: 92, align: 'right' });
        doc.y = headTop + 18;
      }

      ensureSpace(120);
      const y = doc.y;
      // Red text for the balance when at/below half the threshold — visual
      // priority cue mirroring the app's restock tier.
      const urgent = row.state_total <= Math.floor(threshold / 2);
      doc.font('Helvetica').fontSize(9).fillColor('#0F172A')
        .text(row.tool_name, left + 8, y + 3, { width: qty1X - left - 16 });
      doc.font('Helvetica-Bold').fillColor(urgent ? '#DC2626' : '#0F172A')
        .text(String(row.state_total), qty1X, y + 3, { width: 90, align: 'right' });
      doc.font('Helvetica').fillColor('#64748B')
        .text(String(row.hq_sent_total), qty2X, y + 3, { width: 92, align: 'right' });
      doc.moveTo(left, y + 16).lineTo(right, y + 16).strokeColor('#E7E5E4').stroke();
      doc.y = y + 18;
    }

    // Signature blocks
    doc.moveDown(2);
    ensureSpace(120);
    const sigY = doc.y + 20;
    const sigWidth = (width - 40) / 2;
    const blocks = [
      { label: 'Prepared by (State admin)', prefill: req.user.full_name },
      { label: 'Approved by',               prefill: '' },
    ];
    blocks.forEach((b, i) => {
      const x = left + i * (sigWidth + 40);
      doc.moveTo(x, sigY + 30).lineTo(x + sigWidth, sigY + 30).strokeColor('#94A3B8').stroke();
      if (b.prefill) doc.fillColor('#0F172A').font('Helvetica').fontSize(9).text(b.prefill, x, sigY + 16, { width: sigWidth });
      doc.fillColor('#64748B').fontSize(8).text(b.label, x, sigY + 34, { width: sigWidth });
      doc.fillColor('#64748B').fontSize(8).text('Sign / Date', x, sigY + 46, { width: sigWidth });
    });

    doc.end();
  })
);

module.exports = router;
