const jwt = require('jsonwebtoken');
const env = require('../config/env');

function sign(payload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function verify(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = { sign, verify };
