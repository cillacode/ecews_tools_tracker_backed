// Wraps a zod schema and produces an Express middleware that validates the
// chosen part of the request (body, query, or params).
//
// Usage:
//   const schema = z.object({ identifier: z.string(), password: z.string() });
//   router.post('/login', validate(schema, 'body'), handler);

function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed; // replace with the parsed/coerced object
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = validate;
