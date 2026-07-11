import { Router } from 'express';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';
import {
  buildAuthUrl,
  verifyState,
  exchangeCodeForTokens,
  isGoogleCalendarConfigured,
} from '../services/googleCalendar';

const router = Router();

// GET /api/calendar/:businessId/status - member-allowed
router.get('/:businessId/status', requireAuth, async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    'SELECT provider, calendar_id, expires_at FROM calendar_connections WHERE business_id = $1',
    [req.params.businessId]
  );
  res.json({ connections: result.rows });
});

// GET /api/calendar/:businessId/google/connect?client=web|mobile - owner-only
router.get('/:businessId/google/connect', requireAuth, async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can connect a calendar' });
  }

  if (!isGoogleCalendarConfigured()) {
    return res.status(501).json({
      error: 'Google Calendar OAuth is not configured yet. Set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI in .env',
    });
  }

  const client = req.query.client === 'mobile' ? 'mobile' : 'web';
  const authUrl = buildAuthUrl(req.params.businessId, req.user!.userId, client);
  res.json({ authUrl });
});

// DELETE /api/calendar/:businessId/google - owner-only, disconnects
router.delete('/:businessId/google', requireAuth, async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can disconnect a calendar' });
  }

  await query("DELETE FROM calendar_connections WHERE business_id = $1 AND provider = 'google'", [
    req.params.businessId,
  ]);
  res.status(204).send();
});

// GET /api/calendar/google/callback - Google redirects here with ?code=...&state=...
// No requireAuth: Google's redirect can never carry our Bearer token. The signed
// `state` (built in buildAuthUrl) stands in for auth here instead.
router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).send('Missing code or state from Google OAuth redirect.');
  }

  const decoded = verifyState(state);
  if (!decoded) {
    return res.status(400).send('This connection link has expired or is invalid. Please try connecting again.');
  }

  const tokens = await exchangeCodeForTokens(code);
  if (!tokens) {
    return res.status(502).send('Could not complete the Google Calendar connection. Please try again.');
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await query(
    `INSERT INTO calendar_connections (business_id, provider, access_token, refresh_token, expires_at)
     VALUES ($1, 'google', $2, $3, $4)
     ON CONFLICT (business_id, provider)
     DO UPDATE SET access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, calendar_connections.refresh_token),
       expires_at = EXCLUDED.expires_at`,
    [decoded.businessId, tokens.access_token, tokens.refresh_token || null, expiresAt]
  );

  if (decoded.client === 'web') {
    const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
    return res.redirect(`${clientOrigin}/dashboard/settings?calendar=connected`);
  }

  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
        <h2>Google Calendar connected</h2>
        <p>You can close this tab and return to the app.</p>
      </body>
    </html>
  `);
});

export default router;
