import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../config/db';
import { signToken, requireAuth } from '../middleware/auth';

const router = Router();

// Per-IP, not per-account, so an attacker can't dodge the limit by cycling emails
// against one password (credential stuffing) or vice versa. Successful logins don't
// count against the limit - only repeated failures/attempts do, so a legitimate user
// signing in from several devices in a row never gets blocked.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

// Looser than login (registration has no "successful attempts don't count" escape
// hatch, since every request here is by definition a new account), just enough to
// stop automated mass account creation from one IP.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Please try again later.' },
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const pushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']).optional(),
});

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password, fullName } = parsed.data;

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name, role, created_at`,
    [email, passwordHash, fullName]
  );

  const user = result.rows[0];
  const token = signToken({ userId: user.id, email: user.email });

  res.status(201).json({ user, token });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const result = await query(
    'SELECT id, email, full_name, role, password_hash, created_at FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];

  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken({ userId: user.id, email: user.email });
  delete user.password_hash;

  res.json({ user, token });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const result = await query(
    'SELECT id, email, full_name, role, created_at FROM users WHERE id = $1',
    [req.user!.userId]
  );
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// POST /api/auth/push-token - registers (or re-associates) an Expo push token for the
// logged-in user's device. Upserts on the token itself, since a token identifies one
// device/app-install and should follow whichever user is currently logged into it.
router.post('/push-token', requireAuth, async (req, res) => {
  const parsed = pushTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { token, platform } = parsed.data;

  await query(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
    [req.user!.userId, token, platform || 'unknown']
  );

  res.status(204).send();
});

export default router;
