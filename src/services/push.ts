import { query } from '../config/db';

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Expo's push API needs no API key for basic sends - the Expo token itself is the
// routing address. Best-effort: a push failure should never affect the caller (e.g. a
// booking) that triggered it.
async function sendExpoPush(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      console.error('[push] Expo push API error:', res.status, await res.text());
    }
  } catch (err: any) {
    console.error('[push] send failed:', err.message);
  }
}

// Notifies every device registered to a business's members (owner + staff) - used for
// alerts staff should see even when they're not actively looking at the dashboard, e.g.
// a new AI-booked appointment.
export async function sendPushToBusinessMembers(
  businessId: string,
  title: string,
  body: string,
  options?: { data?: Record<string, unknown>; excludeUserId?: string }
): Promise<void> {
  const result = await query(
    `SELECT pt.token FROM push_tokens pt
     JOIN business_members bm ON bm.user_id = pt.user_id
     WHERE bm.business_id = $1 AND bm.user_id != COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [businessId, options?.excludeUserId ?? null]
  );
  if (result.rows.length === 0) return;

  const data = options?.data;

  const messages: PushMessage[] = result.rows.map((r) => ({ to: r.token, title, body, data }));
  await sendExpoPush(messages);
}
