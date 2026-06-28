// Seeds Akwa Ibom and Cross River states from the cleaned JSON.
//
// Reads phase3-states-data.json (sibling file) and inserts:
//   - the state row if missing
//   - every LGA under that state if missing
//   - every facility under its (state, LGA) if missing
//
// Idempotent: all inserts use ON CONFLICT DO NOTHING so re-running the
// seed (or running it against a fresh DB) produces the same result.

const fs   = require('fs');
const path = require('path');
const { pool, withTransaction } = require('../../config/db');

const DATA_PATH = path.join(__dirname, 'phase3-states-data.json');

module.exports = async function seedPhase3States() {
  if (!fs.existsSync(DATA_PATH)) {
    console.warn(`! skip   006_phase3_states.js — ${DATA_PATH} not found`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  await withTransaction(async (client) => {
    let inserted = { states: 0, lgas: 0, facilities: 0 };

    for (const [stateName, payload] of Object.entries(raw)) {
      // ── state ──
      const stateRes = await client.query(
        `INSERT INTO states (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, (xmax = 0) AS is_new`,
        [stateName]
      );
      const stateId = stateRes.rows[0].id;
      if (stateRes.rows[0].is_new) inserted.states++;

      // ── LGAs (one INSERT per LGA, simple and clear) ──
      const lgaIdByName = {};
      for (const lgaName of payload.lgas) {
        const lgaRes = await client.query(
          `INSERT INTO lgas (state_id, name) VALUES ($1, $2)
           ON CONFLICT (state_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, (xmax = 0) AS is_new`,
          [stateId, lgaName]
        );
        lgaIdByName[lgaName] = lgaRes.rows[0].id;
        if (lgaRes.rows[0].is_new) inserted.lgas++;
      }

      // ── facilities ──
      for (const fac of payload.facilities) {
        const lgaId = lgaIdByName[fac.lga];
        if (!lgaId) {
          console.warn(`! orphan facility "${fac.name}" (LGA "${fac.lga}" missing for ${stateName})`);
          continue;
        }
        const facRes = await client.query(
          `INSERT INTO facilities (lga_id, name) VALUES ($1, $2)
           ON CONFLICT (lga_id, name) DO NOTHING
           RETURNING id`,
          [lgaId, fac.name]
        );
        if (facRes.rowCount > 0) inserted.facilities++;
      }
    }

    console.log(
      `  → +${inserted.states} state(s), +${inserted.lgas} LGA(s), ` +
      `+${inserted.facilities} facility/ies (existing rows untouched)`
    );
  });
};
