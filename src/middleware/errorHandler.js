const { ZodError } = require('zod');
const { HttpError } = require('../utils/errors');
const env = require('../config/env');

// 404 handler — registered last, after all routes.
function notFoundHandler(req, res, next) {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
}

// Central error handler — must take 4 args for Express to recognise it.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Validation errors from zod
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Application errors with a known status
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Postgres unique violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Resource already exists' });
  }

  // Postgres foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced resource does not exist' });
  }

  // Postgres check constraint violation
  if (err.code === '23514') {
    return res.status(400).json({ error: 'Constraint violation', details: err.message });
  }

  // Unknown — log fully, return generic message in prod
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    ...(env.isProd ? {} : { message: err.message, stack: err.stack }),
  });
}

module.exports = { notFoundHandler, errorHandler };
