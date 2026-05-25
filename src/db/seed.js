// Seed runner. Executes files in src/db/seeds/ in alphabetical order.
// Supports both .sql and .js seeds:
//   - .sql files are executed verbatim (should use ON CONFLICT to be idempotent)
//   - .js files must export an async function which the runner awaits
//
// Usage: npm run db:seed

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const SEEDS_DIR = path.join(__dirname, 'seeds');

async function run() {
  const files = fs
    .readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();

  console.log(`Running ${files.length} seed file(s)...\n`);

  for (const file of files) {
    const fullPath = path.join(SEEDS_DIR, file);
    try {
      if (file.endsWith('.sql')) {
        const sql = fs.readFileSync(fullPath, 'utf8');
        console.log(`→ run    ${file}  (SQL)`);
        await pool.query(sql);
        console.log(`✓ done   ${file}`);
      } else {
        // Clear require cache so re-runs pick up edits.
        delete require.cache[require.resolve(fullPath)];
        const seedFn = require(fullPath);
        if (typeof seedFn !== 'function') {
          console.warn(`! skip   ${file}  (no exported function)`);
          continue;
        }
        console.log(`→ run    ${file}  (JS)`);
        await seedFn();
      }
    } catch (err) {
      console.error(`✖ fail   ${file}`);
      console.error(err.message);
      throw err;
    }
  }

  console.log('\nSeeds applied.');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
