// Standardised error with an HTTP status code. Throw these from services/routes;
// the error middleware turns them into clean JSON responses.

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest   = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Unauthorized')           => new HttpError(401, msg);
const forbidden    = (msg = 'Forbidden')              => new HttpError(403, msg);
const notFound     = (msg = 'Not found')              => new HttpError(404, msg);
const conflict     = (msg, details)                   => new HttpError(409, msg, details);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
