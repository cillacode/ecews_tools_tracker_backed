// Wraps async route handlers so thrown errors flow into the error middleware
// instead of becoming unhandled promise rejections.
//
// Usage:
//   router.get('/', asyncHandler(async (req, res) => { ... }))

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
