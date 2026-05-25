const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { login, publicUser } = require('../services/authService');

const router = express.Router();

const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
});

// POST /api/auth/login
router.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await login(req.body);
    res.json(result);
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

// POST /api/auth/logout — stateless JWT, so this is just a courtesy endpoint.
// Client should drop the token. (Real revocation would need a token blacklist or rotation.)
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Logged out' });
});

module.exports = router;
