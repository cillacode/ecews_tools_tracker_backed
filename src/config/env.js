// Loads and validates environment variables. Fails fast if anything required is missing.
require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);

if (missing.length) {
  console.error(`✖ Missing required env vars: ${missing.join(', ')}`);
  console.error('  Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const env = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL === 'true',

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  bcryptCost: parseInt(process.env.BCRYPT_COST || '10', 10),

  defaultAdmin: {
    username: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
    email: process.env.DEFAULT_ADMIN_EMAIL || 'admin@mer-tools.local',
    password: process.env.DEFAULT_ADMIN_PASSWORD || 'changeme123',
    name: process.env.DEFAULT_ADMIN_NAME || 'System Administrator',
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = env;
