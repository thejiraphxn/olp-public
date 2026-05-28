import rateLimit from 'express-rate-limit';

// Tight limit for login/register: brute-force defence.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many attempts — try again later' },
});

// Looser limit for the demo-switch endpoint (not sensitive but still limited).
export const demoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'slow down' },
});
