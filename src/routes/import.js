const express = require('express');
const multer  = require('multer');
const { parse } = require('csv-parse');
const { pool }  = require('../config/db');
const { withTransaction } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { badRequest } = require('../utils/errors');

const router = express.Router();

// In-memory storage — we parse the buffer immediately, never touch the disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.csv$/i)) {
      return cb(new Error('Only .csv files are accepted'));
    }
    cb(null, true);
  },
});

// Build a human-readable batch number: DIST-<STATECODE>-<YYYYMMDD>-<seq>.
// State code = first two alpha chars of the admin's state name (uppercased),
// or 'HQ' for super_admin. Sequence is per state per day.
async function generateBatchNo(user) {
  let code = 'HQ';
  let stateId = null;
  if (user.effective_state_id) {
    stateId = user.effective_state_id;
    const s = await pool.query('SELECT name FROM states WHERE id = $1', [stateId]);
    const name = (s.rows[0]?.name ?? 'ST').replace(/[^A-Za-z]/g, '');
    code = (name.slice(0, 2) || 'ST').toUpperCase();
  }
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const prefix = `DIST-${code}-${ymd}-`;

  // Next sequence for this prefix today.
  const seqRes = await pool.query(
    `SELECT COUNT(DISTINCT batch_no)::int AS n FROM stock_movements WHERE batch_no LIKE $1`,
    [`${prefix}%`]
  );
  const seq = String(seqRes.rows[0].n + 1).padStart(4, '0');
  return `${prefix}${seq}`;
}

// ── GET /api/import/template ──────────────────────────────────────────────────
// Returns a ready-to-fill CSV template the admin can download and populate.
router.get('/template', requireAuth, requireRole('admin'), (req, res) => {
  const csv = [
    'facility_name,tool_name,quantity,reference_no,note',
    '"Sango PHC","ART register",50,WB-001,"Opening balance"',
    '"Badagry General Hospital","PMTCT register",30,,',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="import-template.csv"');
  res.send(csv);
});

// ── POST /api/import/opening-balances ────────────────────────────────────────
// Parses a CSV, validates every row, then records RECEIPT movements in one transaction.
router.post(
  '/opening-balances',
  requireAuth,
  requireRole('admin'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');

    // Parse CSV from the in-memory buffer
    const records = await new Promise((resolve, reject) => {
      parse(req.file.buffer, {
        columns:           true,
        skip_empty_lines:  true,
        trim:              true,
      }, (err, data) => {
        if (err) reject(badRequest(`CSV parse error: ${err.message}`));
        else resolve(data);
      });
    });

    if (records.length === 0) throw badRequest('CSV contains no data rows');

    // A state admin can only distribute to facilities in their own state.
    // Scope the facility lookup accordingly (super_admin uses the state import).
    const facParams = [];
    let facWhere = 'WHERE f.is_active = TRUE';
    if (req.user.role !== 'super_admin' && req.user.effective_state_id) {
      facParams.push(req.user.effective_state_id);
      facWhere += ` AND l.state_id = $1`;
    }
    const facilityRows = await pool.query(
      `SELECT f.id, f.name, l.state_id FROM facilities f JOIN lgas l ON l.id = f.lga_id ${facWhere}`,
      facParams
    );
    const toolRows = await pool.query('SELECT id, name FROM tools WHERE is_active = TRUE');

    const facilityMap   = new Map(facilityRows.rows.map((f) => [f.name.toLowerCase(), f.id]));
    const facilityState = new Map(facilityRows.rows.map((f) => [f.id, f.state_id]));
    const toolMap       = new Map(toolRows.rows.map((t) => [t.name.toLowerCase(), t.id]));

    // One batch number per import run, stamped on every movement it creates,
    // so a per-facility gate-pass PDF can be printed afterwards.
    const batchNo = await generateBatchNo(req.user);

    // Validate all rows first — fail fast with a list of errors
    const validated = [];
    const errors    = [];

    records.forEach((row, i) => {
      const rowNum = i + 2; // 1-indexed, accounting for header
      const facilityId = facilityMap.get((row.facility_name ?? '').toLowerCase().trim());
      const toolId     = toolMap.get((row.tool_name ?? '').toLowerCase().trim());
      const qty        = parseInt(row.quantity, 10);

      if (!facilityId) {
        errors.push({ row: rowNum, field: 'facility_name', message: `Facility "${row.facility_name}" not found` });
      }
      if (!toolId) {
        errors.push({ row: rowNum, field: 'tool_name', message: `Tool "${row.tool_name}" not found` });
      }
      if (!qty || qty <= 0 || isNaN(qty)) {
        errors.push({ row: rowNum, field: 'quantity', message: `Invalid quantity "${row.quantity}" — must be a positive integer` });
      }
      if (facilityId && toolId && qty > 0) {
        validated.push({
          facilityId,
          toolId,
          quantity:    qty,
          referenceNo: row.reference_no || null,
          note:        row.note        || null,
        });
      }
    });

    if (errors.length > 0) {
      return res.status(422).json({
        error:   'Validation failed — no records imported',
        errors,
        total:   records.length,
        invalid: errors.length,
      });
    }

    // All rows valid — run in one transaction
    const movements = await withTransaction(async (client) => {
      const results = [];
      for (const item of validated) {
        // Created as PENDING_ACK — the facility's stock is only credited when
        // its DEC confirms physical receipt on the Incoming page. No FACILITY
        // balance upsert happens here.
        const m = await client.query(
          `INSERT INTO stock_movements
             (movement_type, facility_id, tool_id, quantity, reference_no, note, performed_by, batch_no, ack_status)
           VALUES ('RECEIPT', $1, $2, $3, $4, $5, $6, $7, 'PENDING_ACK')
           RETURNING id`,
          [item.facilityId, item.toolId, item.quantity, item.referenceNo, item.note, req.user.id, batchNo]
        );

        // An opening balance is stock the state already received from HQ AND
        // already pushed to the facility. Credit state_stock (received) so it
        // stays consistent with the derived state balance used by the
        // distribution guard — received grows to cover this distribution,
        // leaving net on-hand unchanged. (This RECEIPT row already counts as
        // "distributed" in that derivation.)
        const stateId = facilityState.get(item.facilityId);
        if (stateId) {
          await client.query(
            `INSERT INTO state_stock (state_id, tool_id, quantity, last_movement_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (state_id, tool_id)
             DO UPDATE SET quantity = state_stock.quantity + $3, last_movement_at = NOW(), updated_at = NOW()`,
            [stateId, item.toolId, item.quantity]
          );
        }

        results.push(m.rows[0].id);
      }
      return results;
    });

    res.json({
      message:  `Successfully imported ${movements.length} records`,
      imported: movements.length,
      total:    records.length,
      batch_no: batchNo,
    });
  })
);

// ══════════════════════════════════════════════════════════════════════════
// HQ (super_admin) — bulk import of tools sent to STATES
// ══════════════════════════════════════════════════════════════════════════

// ── GET /api/import/state-template ────────────────────────────────────────────
router.get('/state-template', requireAuth, requireRole('super_admin'), (req, res) => {
  const csv = [
    'state_name,tool_name,quantity,reference_no,note',
    '"Lagos","ART register",500,HQ-001,"Q3 national distribution"',
    '"Akwa Ibom","PMTCT register",300,,',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="state-import-template.csv"');
  res.send(csv);
});

// ── POST /api/import/state-distributions ──────────────────────────────────────
// Parses a CSV of (state_name, tool_name, quantity, ...), validates every row,
// then records state RECEIPT movements + state_stock in one transaction.
router.post(
  '/state-distributions',
  requireAuth,
  requireRole('super_admin'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');

    const records = await new Promise((resolve, reject) => {
      parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true }, (err, data) => {
        if (err) reject(badRequest(`CSV parse error: ${err.message}`));
        else resolve(data);
      });
    });
    if (records.length === 0) throw badRequest('CSV contains no data rows');

    const stateRows = await pool.query('SELECT id, name FROM states');
    const toolRows  = await pool.query('SELECT id, name FROM tools WHERE is_active = TRUE');
    const stateMap  = new Map(stateRows.rows.map((s) => [s.name.toLowerCase(), s.id]));
    const toolMap   = new Map(toolRows.rows.map((t) => [t.name.toLowerCase(), t.id]));

    const validated = [];
    const errors    = [];

    records.forEach((row, i) => {
      const rowNum  = i + 2;
      const stateId = stateMap.get((row.state_name ?? '').toLowerCase().trim());
      const toolId  = toolMap.get((row.tool_name ?? '').toLowerCase().trim());
      const qty     = parseInt(row.quantity, 10);

      if (!stateId) errors.push({ row: rowNum, field: 'state_name', message: `State "${row.state_name}" not found` });
      if (!toolId)  errors.push({ row: rowNum, field: 'tool_name',  message: `Tool "${row.tool_name}" not found` });
      if (!qty || qty <= 0 || isNaN(qty)) {
        errors.push({ row: rowNum, field: 'quantity', message: `Invalid quantity "${row.quantity}" — must be a positive integer` });
      }
      if (stateId && toolId && qty > 0) {
        validated.push({ stateId, toolId, quantity: qty, referenceNo: row.reference_no || null, note: row.note || null });
      }
    });

    if (errors.length > 0) {
      return res.status(422).json({ error: 'Validation failed — no records imported', errors, total: records.length, invalid: errors.length });
    }

    const inserted = await withTransaction(async (client) => {
      const ids = [];
      for (const item of validated) {
        const m = await client.query(
          `INSERT INTO state_movements (movement_type, state_id, tool_id, quantity, reference_no, note, performed_by)
           VALUES ('RECEIPT', $1, $2, $3, $4, $5, $6) RETURNING id`,
          [item.stateId, item.toolId, item.quantity, item.referenceNo, item.note, req.user.id]
        );
        await client.query(
          `INSERT INTO state_stock (state_id, tool_id, quantity, last_movement_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (state_id, tool_id)
           DO UPDATE SET quantity = state_stock.quantity + $3, last_movement_at = NOW(), updated_at = NOW()`,
          [item.stateId, item.toolId, item.quantity]
        );
        ids.push(m.rows[0].id);
      }
      return ids;
    });

    res.json({ message: `Successfully imported ${inserted.length} records`, imported: inserted.length, total: records.length });
  })
);

module.exports = router;
