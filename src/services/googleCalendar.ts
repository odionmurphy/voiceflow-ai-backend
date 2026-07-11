import jwt from 'jsonwebtoken';
import { query } from '../config/db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI || '';

export interface OAuthState {
  businessId: string;
  userId: string;
  client: 'web' | 'mobile';
}

// Google's redirect can't carry our app's Bearer token, so the OAuth `state` param
// itself is a short-lived signed token verified on callback instead of requireAuth.
export function buildAuthUrl(businessId: string, userId: string, client: 'web' | 'mobile') {
  if (!CLIENT_ID || !REDIRECT_URI) return null;

  const state = jwt.sign({ businessId, userId, client } as OAuthState, JWT_SECRET, {
    expiresIn: '10m',
  });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function verifyState(state: string): OAuthState | null {
  try {
    return jwt.verify(state, JWT_SECRET) as OAuthState;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      console.error('[googleCalendar] token exchange failed:', res.status, await res.text());
      return null;
    }
    return (await res.json()) as TokenResponse;
  } catch (err: any) {
    console.error('[googleCalendar] token exchange failed:', err.message);
    return null;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      console.error('[googleCalendar] token refresh failed:', res.status, await res.text());
      return null;
    }
    return (await res.json()) as TokenResponse;
  } catch (err: any) {
    console.error('[googleCalendar] token refresh failed:', err.message);
    return null;
  }
}

// Returns a valid access token for the business's connected Google Calendar, refreshing
// it first if it's expired/near-expiry. Returns null if not connected or refresh fails -
// callers treat that as "skip calendar sync", never as a hard error.
export async function getValidAccessToken(businessId: string): Promise<string | null> {
  const result = await query(
    `SELECT access_token, refresh_token, expires_at FROM calendar_connections
     WHERE business_id = $1 AND provider = 'google'`,
    [businessId]
  );
  const conn = result.rows[0];
  if (!conn) return null;

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 60_000) {
    return conn.access_token;
  }

  if (!conn.refresh_token) return null;
  const refreshed = await refreshAccessToken(conn.refresh_token);
  if (!refreshed) return null;

  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  await query(
    `UPDATE calendar_connections SET access_token = $1, expires_at = $2
     WHERE business_id = $3 AND provider = 'google'`,
    [refreshed.access_token, newExpiresAt, businessId]
  );
  return refreshed.access_token;
}

interface EventInput {
  summary: string;
  description?: string;
  startTime: string; // ISO
  endTime: string; // ISO
}

// All three of these are best-effort: a Calendar API failure (revoked access, Google
// outage) must never fail or block the appointment request that triggered it - callers
// just get null/no-op back and log continues without the sync having happened.
export async function createCalendarEvent(
  businessId: string,
  event: EventInput
): Promise<string | null> {
  const token = await getValidAccessToken(businessId);
  if (!token) return null;

  try {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.startTime },
          end: { dateTime: event.endTime },
        }),
      }
    );
    if (!res.ok) {
      console.error('[googleCalendar] create event failed:', res.status, await res.text());
      return null;
    }
    const created = (await res.json()) as { id?: string };
    return created.id ?? null;
  } catch (err: any) {
    console.error('[googleCalendar] create event failed:', err.message);
    return null;
  }
}

export async function updateCalendarEvent(
  businessId: string,
  eventId: string,
  event: Partial<EventInput>
): Promise<void> {
  const token = await getValidAccessToken(businessId);
  if (!token) return;

  try {
    const body: Record<string, unknown> = {};
    if (event.startTime) body.start = { dateTime: event.startTime };
    if (event.endTime) body.end = { dateTime: event.endTime };
    if (event.summary) body.summary = event.summary;

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      console.error('[googleCalendar] update event failed:', res.status, await res.text());
    }
  } catch (err: any) {
    console.error('[googleCalendar] update event failed:', err.message);
  }
}

export async function deleteCalendarEvent(businessId: string, eventId: string): Promise<void> {
  const token = await getValidAccessToken(businessId);
  if (!token) return;

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    // 410 Gone means it was already deleted on the Google side - treat as success.
    if (!res.ok && res.status !== 410 && res.status !== 404) {
      console.error('[googleCalendar] delete event failed:', res.status, await res.text());
    }
  } catch (err: any) {
    console.error('[googleCalendar] delete event failed:', err.message);
  }
}

export function isGoogleCalendarConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}
