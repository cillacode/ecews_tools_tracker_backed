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

    // Pre-load lookup maps
    const facilityRows = await pool.query('SELECT id, name FROM facilities WHERE is_active = TRUE');
    const toolRows     = await pool.query('SELECT id, name FROM tools WHERE is_active = TRUE');

    const facilityMap = new Map(facilityRows.rows.map((f) => [f.name.toLowerCase(), f.id]));
    const toolMap     = new Map(toolRows.rows.map((t) => [t.name.toLowerCase(), t.id]));

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
        const m = await client.query(
          `INSERT INTO stock_movements
             (movement_type, facility_id, tool_id, quantity, reference_no, note, performed_by)
           VALUES ('RECEIPT', $1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [item.facilityId, item.toolId, item.quantity, item.referenceNo, item.note, req.user.id]
        );

        // Upsert balance
        await client.query(
          `INSERT INTO facility_stock (facility_id, tool_id, quantity, last_movement_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (facility_id, tool_id)
           DO UPDATE SET
             quantity         = facility_stock.quantity + $3,
             last_movement_at = NOW(),
             updated_at       = NOW()`,
          [item.facilityId, item.toolId, item.quantity]
        );

        results.push(m.rows[0].id);
      }
      return results;
    });

    res.json({
      message:  `Successfully imported ${movements.length} records`,
      imported: movements.length,
      total:    records.length,
    });
  })
);

module.exports = router;
