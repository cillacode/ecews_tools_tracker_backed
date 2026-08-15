const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { z } = require('zod');
const { pool } = require('../config/db');

// Brand logo shown at the top of every delivery note. Bundled with the backend
// (copied from the frontend's public/logoe.png) so it ships with this service.
// Resolved once; null if the file is missing so PDF generation never crashes.
const LOGO_PATH = (() => {
  const p = path.join(__dirname, '..', '..', 'assets', 'logoe.png');
  return fs.existsSync(p) ? p : null;
})();
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { badRequest, forbidden, notFound } = require('../utils/errors');

const router = express.Router();

// ── PDF rendering ─────────────────────────────────────────────────────────────
// One gate-pass page. `page` = { stateName, facilityName, dateStr, reference,
//   issuedBy, lines: [{ tool, quantity }] }. Adds a new page first when `first`
//   is false, so a batch can stack many facilities in one document.
function renderGatePassPage(doc, page, first) {
  if (!first) doc.addPage();

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
    .text('MER Tools — Delivery Note', left, doc.y);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor('#64748B')
    .text('Present this signed delivery note at the gate before tools leave the state office.');
  doc.moveDown(0.8);

  // Meta grid
  doc.fillColor('#0F172A').fontSize(10);
  const metaTop = doc.y;
  const col2x = left + width / 2;
  doc.font('Helvetica-Bold').text('State:', left, metaTop);
  doc.font('Helvetica').text(page.stateName, left + 90, metaTop);
  doc.font('Helvetica-Bold').text('Facility:', col2x, metaTop);
  doc.font('Helvetica').text(page.facilityName, col2x + 60, metaTop, { width: width / 2 - 60 });

  const metaRow2 = doc.y + 4;
  doc.font('Helvetica-Bold').text('Date:', left, metaRow2);
  doc.font('Helvetica').text(page.dateStr, left + 90, metaRow2);
  doc.font('Helvetica-Bold').text('Reference:', col2x, metaRow2);
  doc.font('Helvetica').text(page.reference, col2x + 60, metaRow2);

  doc.moveDown(1.2);

  // Table header
  const tableTop = doc.y;
  const qtyX = right - 70;
  doc.rect(left, tableTop, width, 20).fill('#14532D');
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10);
  doc.text('Tool', left + 8, tableTop + 6);
  doc.text('Quantity', qtyX, tableTop + 6, { width: 62, align: 'right' });

  // Rows
  let y = tableTop + 20;
  let total = 0;
  doc.font('Helvetica').fontSize(10).fillColor('#0F172A');
  page.lines.forEach((ln, i) => {
    if (y > doc.page.height - 160) { doc.addPage(); y = doc.page.margins.top; }
    if (i % 2 === 1) doc.rect(left, y, width, 18).fill('#F5F5F4').fillColor('#0F172A');
    doc.fillColor('#0F172A').text(ln.tool, left + 8, y + 4, { width: width - 90 });
    doc.text(String(ln.quantity), qtyX, y + 4, { width: 62, align: 'right' });
    total += ln.quantity;
    y += 18;
  });

  // Total row
  doc.rect(left, y, width, 20).fill('#F0FDF4');
  doc.fillColor('#14532D').font('Helvetica-Bold').fontSize(10);
  doc.text('Total', left + 8, y + 6);
  doc.text(String(total), qtyX, y + 6, { width: 62, align: 'right' });
  y += 44;

  // ── Sign-off ──────────────────────────────────────────────────────────────
  // Lines only (no boxes), compact. Row 1: Remark (full width). Rows 2-4:
  // role | Designation | Sign and date.
  const rowH = 30;
  const needed = rowH * 4 + 24;
  if (y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  } else {
    y += 18;
  }

  doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10).text('Sign-off', left, y);
  y += 14;

  // A single write-on field: a line to sign on, with a small label beneath it.
  const field = (label, x, yy, w) => {
    const lineY = yy + 13;
    doc.moveTo(x, lineY).lineTo(x + w - 14, lineY).lineWidth(0.7).strokeColor('#94A3B8').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text(label, x, lineY + 3, { width: w - 14 });
  };

  // Row 1 — Remark (spans the full width).
  field('Remark', left, y, width);
  y += rowH;

  // Rows 2-4 — three columns each.
  const c1 = Math.round(width * 0.40); // role + name
  const c2 = Math.round(width * 0.30); // designation
  const c3 = width - c1 - c2;          // sign and date
  const roles = ['Approved by', 'Delivered by', 'Facility received by'];
  for (const role of roles) {
    field(role,            left,           y, c1);
    field('Designation',   left + c1,      y, c2);
    field('Sign and date', left + c1 + c2, y, c3);
    y += rowH;
  }
}

function sendPdf(res, filename, build) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  build(doc);
  doc.end();
}

const todayStr = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Guard: a state admin may only print for facilities in their own state.
async function assertFacilityInScope(req, facilityId) {
  const r = await pool.query(
    `SELECT f.name AS facility_name, s.id AS state_id, s.name AS state_name
     FROM facilities f JOIN lgas l ON l.id = f.lga_id JOIN states s ON s.id = l.state_id
     WHERE f.id = $1`,
    [facilityId]
  );
  if (r.rows.length === 0) throw notFound('Facility not found');
  const row = r.rows[0];
  if (req.user.role !== 'super_admin' && row.state_id !== req.user.effective_state_id) {
    throw forbidden('Facility is outside your state');
  }
  return row;
}

// ── POST /api/gate-pass/facility ──────────────────────────────────────────────
// Ad-hoc gate pass from the Facility Detail page. Body: { facility_id,
// reference_no?, lines: [{ tool_id, quantity }] }.
const facilitySchema = z.object({
  facility_id:  z.number().int().positive(),
  reference_no: z.string().trim().optional(),
  lines: z.array(z.object({
    tool_id:  z.number().int().positive(),
    quantity: z.number().int().min(1),
  })).min(1, 'Select at least one tool'),
});

router.post(
  '/facility',
  requireAuth,
  requireRole('admin'),
  validate(facilitySchema),
  asyncHandler(async (req, res) => {
    const { facility_id, reference_no, lines } = req.body;
    const fac = await assertFacilityInScope(req, facility_id);

    // Resolve tool names.
    const ids = lines.map((l) => l.tool_id);
    const toolRes = await pool.query('SELECT id, name FROM tools WHERE id = ANY($1)', [ids]);
    const nameById = new Map(toolRes.rows.map((t) => [t.id, t.name]));
    const pageLines = lines.map((l) => ({ tool: nameById.get(l.tool_id) ?? `Tool #${l.tool_id}`, quantity: l.quantity }));

    const reference = reference_no?.trim() || `DN-${Date.now().toString().slice(-8)}`;
    sendPdf(res, `delivery-note-${fac.facility_name.replace(/\s+/g, '-')}.pdf`, (doc) => {
      renderGatePassPage(doc, {
        stateName: fac.state_name,
        facilityName: fac.facility_name,
        dateStr: todayStr(),
        reference,
        issuedBy: req.user.full_name,
        lines: pageLines,
      }, true);
    });
  })
);

// ── POST /api/gate-pass/facilities ────────────────────────────────────────────
// Combined delivery note for several facilities at once — one page per facility.
// Used by bulk distribution. Body: { reference_no?, facilities: [{ facility_id,
// lines: [{ tool_id, quantity }] }] }.
const facilitiesSchema = z.object({
  reference_no: z.string().trim().optional(),
  facilities: z.array(z.object({
    facility_id: z.number().int().positive(),
    lines: z.array(z.object({
      tool_id:  z.number().int().positive(),
      quantity: z.number().int().min(1),
    })).min(1),
  })).min(1, 'Select at least one facility'),
});

router.post(
  '/facilities',
  requireAuth,
  requireRole('admin'),
  validate(facilitiesSchema),
  asyncHandler(async (req, res) => {
    const { reference_no, facilities } = req.body;

    // Resolve all tool names in one query.
    const allToolIds = [...new Set(facilities.flatMap((f) => f.lines.map((l) => l.tool_id)))];
    const toolRes = await pool.query('SELECT id, name FROM tools WHERE id = ANY($1)', [allToolIds]);
    const nameById = new Map(toolRes.rows.map((t) => [t.id, t.name]));

    // Scope-check each facility and build its page.
    const pages = [];
    for (const f of facilities) {
      const fac = await assertFacilityInScope(req, f.facility_id);
      pages.push({
        stateName: fac.state_name,
        facilityName: fac.facility_name,
        dateStr: todayStr(),
        reference: reference_no?.trim() || `DN-${Date.now().toString().slice(-8)}`,
        issuedBy: req.user.full_name,
        lines: f.lines.map((l) => ({ tool: nameById.get(l.tool_id) ?? `Tool #${l.tool_id}`, quantity: l.quantity })),
      });
    }

    sendPdf(res, `delivery-notes-${new Date().toISOString().slice(0, 10)}.pdf`, (doc) => {
      pages.forEach((page, i) => renderGatePassPage(doc, page, i === 0));
    });
  })
);

// ── GET /api/gate-pass/batch/:batchNo ─────────────────────────────────────────
// One combined PDF, a page per facility in an import batch.
router.get(
  '/batch/:batchNo',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const batchNo = req.params.batchNo;

    const rows = (await pool.query(
      `SELECT
         f.id AS facility_id, f.name AS facility_name,
         s.id AS state_id, s.name AS state_name,
         t.name AS tool_name, m.quantity
       FROM stock_movements m
       JOIN facilities f ON f.id = m.facility_id
       JOIN lgas       l ON l.id = f.lga_id
       JOIN states     s ON s.id = l.state_id
       JOIN tools      t ON t.id = m.tool_id
       WHERE m.batch_no = $1
       ORDER BY f.name, t.name`,
      [batchNo]
    )).rows;

    if (rows.length === 0) throw notFound('Batch not found');

    // Scope: state admin only prints batches for their own state.
    if (req.user.role !== 'super_admin' && rows[0].state_id !== req.user.effective_state_id) {
      throw forbidden('This batch is outside your state');
    }

    // Group rows by facility.
    const byFacility = new Map();
    for (const r of rows) {
      if (!byFacility.has(r.facility_id)) {
        byFacility.set(r.facility_id, { facilityName: r.facility_name, stateName: r.state_name, lines: [] });
      }
      byFacility.get(r.facility_id).lines.push({ tool: r.tool_name, quantity: r.quantity });
    }

    sendPdf(res, `delivery-notes-${batchNo}.pdf`, (doc) => {
      let first = true;
      for (const fac of byFacility.values()) {
        renderGatePassPage(doc, {
          stateName: fac.stateName,
          facilityName: fac.facilityName,
          dateStr: todayStr(),
          reference: batchNo,
          issuedBy: req.user.full_name,
          lines: fac.lines,
        }, first);
        first = false;
      }
    });
  })
);

module.exports = router;
