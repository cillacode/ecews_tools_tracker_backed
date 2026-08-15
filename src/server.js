const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const { pool } = require('./config/db');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const authRoutes         = require('./routes/auth');
const toolsRoutes        = require('./routes/tools');
const facilitiesRoutes   = require('./routes/facilities');
const thematicAreasRoutes = require('./routes/thematicAreas');
const statesRoutes       = require('./routes/states');
const lgasRoutes         = require('./routes/lgas');
const movementsRoutes    = require('./routes/movements');
const dashboardRoutes    = require('./routes/dashboard');
const usersRoutes        = require('./routes/users');
const thresholdsRoutes   = require('./routes/thresholds');
const reportsRoutes      = require('./routes/reports');
const importRoutes       = require('./routes/import');
const usageRoutes        = require('./routes/usage');
const adminRoutes        = require('./routes/admin');
const stateMovementsRoutes = require('./routes/stateMovements');
const gatePassRoutes       = require('./routes/gatePass');
const procurementRoutes    = require('./routes/procurement');
const servicePointsRoutes  = require('./routes/servicePoints');

const app = express();

// Trust the first proxy hop. Required on Render/Netlify/etc so that
// express-rate-limit reads the real client IP from X-Forwarded-For
// instead of treating every request as coming from the load balancer.
app.set('trust proxy', 1);

// ── Security & infrastructure middleware ──────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow tools without origin (curl, Postman) and any origin in CORS_ORIGINS.
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

// Generous global rate limit. Tighten per-route where it matters.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Tighter limit specifically for auth (brute-force protection).
app.use(
  '/api/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts. Please try again later.' },
  })
);

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'MER Tools Backend',
    status: 'ok',
    version: '0.1.0',
  });
});

app.get('/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth',           authRoutes);
app.use('/api/tools',         toolsRoutes);
app.use('/api/facilities',    facilitiesRoutes);
app.use('/api/thematic-areas', thematicAreasRoutes);
app.use('/api/states',        statesRoutes);
app.use('/api/lgas',          lgasRoutes);
app.use('/api/movements',     movementsRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/users',         usersRoutes);
app.use('/api/thresholds',    thresholdsRoutes);
app.use('/api/reports',       reportsRoutes);
app.use('/api/import',        importRoutes);
app.use('/api/usage',         usageRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/state-movements', stateMovementsRoutes);
app.use('/api/gate-pass',     gatePassRoutes);
app.use('/api/procurement',   procurementRoutes);
app.use('/api/service-points', servicePointsRoutes);

// ── 404 + error handlers (must be last) ───────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Boot ───────────────────────────────────────────────────────────────────
const server = app.listen(env.port, () => {
  console.log(`✓ MER Tools API listening on http://localhost:${env.port}`);
  console.log(`  env=${env.nodeEnv}  CORS allowed: ${env.corsOrigins.join(', ')}`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
