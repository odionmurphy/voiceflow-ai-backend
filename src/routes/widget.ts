import { createHash } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { DateTime } from 'luxon';
import { query, withTransaction } from '../config/db';
import {
  sendAppointmentConfirmation,
  sendWidgetLeadNotification,
} from '../services/notifications';
import { sendPushToBusinessMembers } from '../services/push';
import { createCalendarEvent } from '../services/googleCalendar';

const router = Router();
const DAY_MS = 24 * 60 * 60 * 1000;

interface WidgetContext {
  business: {
    id: string;
    name: string;
    phone_number: string | null;
    timezone: string;
    business_hours: Record<string, [string, string]>;
  };
  settings: {
    greeting: string;
    services: { name: string; durationMinutes: number; price: number }[];
    booking_rules: {
      minNoticeHours?: number;
      bufferMinutes?: number;
      maxPerDay?: number;
      forwardingNumber?: string;
      notifyEmail?: string;
      privacyPolicyUrl?: string;
      websiteDomains?: string[];
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadWidgetContext(businessId: string): Promise<WidgetContext | null> {
  const result = await query(
    `SELECT b.id, b.name, b.phone_number, b.timezone, b.business_hours,
            a.greeting, a.services, a.faq, a.booking_rules, s.status AS subscription_status
     FROM businesses b
     JOIN ai_settings a ON a.business_id = b.id
     JOIN subscriptions s ON s.business_id = b.id
     WHERE b.id = $1`,
    [businessId]
  );
  const row = result.rows[0];
  if (!row || !['active', 'trialing'].includes(row.subscription_status)) return null;
  return {
    business: row,
    settings: {
      greeting: row.greeting,
      services: row.services ?? [],
      booking_rules: row.booking_rules ?? {},
    },
  };
}

async function widgetAccess(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  const context = await loadWidgetContext(req.params.businessId);
  if (!origin || !context?.settings.booking_rules.websiteDomains?.includes(origin)) {
    return res.status(403).json({ error: 'This website is not allowed to use the chat widget.' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  res.locals.widgetContext = context;
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

router.use('/:businessId', widgetAccess);

let requestsSinceCleanup = 0;
router.use('/:businessId', async (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const context = res.locals.widgetContext as WidgetContext;
  const ipHash = createHash('sha256')
    .update(`${context.business.id}:${req.ip || req.socket.remoteAddress || 'unknown'}`)
    .digest('hex');
  const result = await query(
    `INSERT INTO widget_rate_limits (business_id, ip_hash, window_start, request_count)
     VALUES ($1, $2, date_trunc('minute', now()), 1)
     ON CONFLICT (business_id, ip_hash, window_start)
     DO UPDATE SET request_count = widget_rate_limits.request_count + 1
     RETURNING request_count`,
    [context.business.id, ipHash]
  );
  requestsSinceCleanup += 1;
  if (requestsSinceCleanup >= 100) {
    requestsSinceCleanup = 0;
    await query("DELETE FROM widget_rate_limits WHERE window_start < now() - interval '2 hours'");
  }
  if (Number(result.rows[0].request_count) > 30) {
    return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  }
  next();
});

function getService(context: WidgetContext, name: unknown) {
  return typeof name === 'string'
    ? context.settings.services.find((service) => service.name === name)
    : undefined;
}

async function getAvailableSlots(
  context: WidgetContext,
  date: string,
  serviceName: unknown
) {
  const service = getService(context, serviceName);
  if (!service) return { error: 'Choose a service configured by this business.' } as const;
  const timezone = context.business.timezone || 'UTC';
  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid || day.toISODate() !== date) {
    return { error: 'Choose a valid date.' } as const;
  }
  if (
    day.startOf('day').toMillis() < DateTime.now().setZone(timezone).startOf('day').toMillis() ||
    day.startOf('day').toMillis() > Date.now() + 90 * DAY_MS
  ) {
    return { error: 'Choose a date within the next 90 days.' } as const;
  }
  const dayOfWeek = day.setLocale('en').toFormat('ccc').toLowerCase();
  const hours = context.business.business_hours?.[dayOfWeek];
  if (!hours) return { slots: [] as string[] };
  const dayStart = DateTime.fromISO(`${date}T${hours[0]}`, { zone: timezone });
  const dayEnd = DateTime.fromISO(`${date}T${hours[1]}`, { zone: timezone });
  if (!dayStart.isValid || !dayEnd.isValid || dayEnd <= dayStart) {
    return { error: 'The business has invalid opening hours for this date.' } as const;
  }

  const start = day.startOf('day').toUTC().toJSDate();
  const end = day.plus({ days: 1 }).startOf('day').toUTC().toJSDate();
  const bookedResult = await query(
    `SELECT start_time, end_time FROM appointments
     WHERE business_id = $1 AND status != 'cancelled'
       AND start_time < $3 AND end_time > $2`,
    [context.business.id, start, end]
  );
  const booked = bookedResult.rows.map((appointment) => ({
    start: new Date(appointment.start_time).getTime(),
    end: new Date(appointment.end_time).getTime(),
  }));
  const durationMs = service.durationMinutes * 60_000;
  const bufferMs = Math.max(0, context.settings.booking_rules.bufferMinutes ?? 0) * 60_000;
  const minStart = Date.now() + Math.max(0, context.settings.booking_rules.minNoticeHours ?? 0) * 3_600_000;
  const slots: string[] = [];
  for (let slot = dayStart.toMillis(); slot + durationMs <= dayEnd.toMillis(); slot += 15 * 60_000) {
    const slotEnd = slot + durationMs;
    if (slot < minStart) continue;
    if (booked.some((booking) => slot < booking.end + bufferMs && slotEnd > booking.start - bufferMs)) {
      continue;
    }
    slots.push(new Date(slot).toISOString());
  }

  const maxPerDay = context.settings.booking_rules.maxPerDay;
  if (maxPerDay != null) {
    const countResult = await query(
      `SELECT count(*)::int AS count FROM appointments
       WHERE business_id = $1 AND status != 'cancelled'
         AND start_time >= $2 AND start_time < $3`,
      [context.business.id, start, end]
    );
    if (Number(countResult.rows[0].count) >= maxPerDay) return { slots: [] as string[] };
  }
  return { slots } as const;
}

router.options('/:businessId/:action', (_req, res) => res.sendStatus(204));

router.get('/:businessId/config', (_req, res) => {
  const { business, settings } = res.locals.widgetContext as WidgetContext;
  res.json({
    business: {
      name: business.name,
      phoneNumber: business.phone_number,
      timezone: business.timezone,
      businessHours: business.business_hours,
    },
    greeting: settings.greeting,
    services: settings.services,
    privacyPolicyUrl: settings.booking_rules.privacyPolicyUrl ?? null,
    contactPhone: business.phone_number,
  });
});

router.get('/:businessId/availability', async (req, res) => {
  const date = String(req.query.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
  }
  const result = await getAvailableSlots(
    res.locals.widgetContext as WidgetContext,
    date,
    req.query.service
  );
  if ('error' in result) return res.status(400).json(result);
  res.json(result);
});

router.post('/:businessId/book', async (req, res) => {
  const context = res.locals.widgetContext as WidgetContext;
  if (!isRecord(req.body)) return res.status(400).json({ error: 'Invalid booking request.' });
  const { name, phone, email, serviceName, startTime, consent } = req.body;
  const validEmail =
    email === undefined ||
    email === '' ||
    (typeof email === 'string' &&
      email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (
    typeof name !== 'string' ||
    name.trim().length < 2 ||
    name.trim().length > 120 ||
    typeof phone !== 'string' ||
    !/^\+[1-9]\d{7,14}$/.test(phone) ||
    !validEmail ||
    typeof startTime !== 'string' ||
    !Number.isFinite(Date.parse(startTime)) ||
    consent !== true
  ) {
    return res.status(400).json({
      error: 'Enter your name, phone number with country code, a valid appointment time, and accept the privacy notice.',
    });
  }
  const service = getService(context, serviceName);
  if (!service) return res.status(400).json({ error: 'Choose a valid service.' });
  const start = new Date(startTime);
  const date = DateTime.fromJSDate(start, { zone: context.business.timezone || 'UTC' }).toISODate();
  if (!date) return res.status(400).json({ error: 'Choose a valid appointment date.' });
  const availability = await getAvailableSlots(context, date, service.name);
  if ('error' in availability) return res.status(400).json(availability);
  if (!availability.slots.includes(start.toISOString())) {
    return res.status(409).json({ error: 'That time is no longer available. Please choose another.' });
  }

  const end = new Date(start.getTime() + service.durationMinutes * 60_000);
  let booking: {
    appointment: { id: string };
    customerId: string;
  };
  try {
    booking = await withTransaction(async (client) => {
      await client.query('SELECT id FROM businesses WHERE id = $1 FOR UPDATE', [
        context.business.id,
      ]);
      if (context.settings.booking_rules.maxPerDay != null) {
        const dayStart = DateTime.fromISO(date, {
          zone: context.business.timezone || 'UTC',
        }).startOf('day').toUTC().toJSDate();
        const dayEnd = DateTime.fromISO(date, {
          zone: context.business.timezone || 'UTC',
        }).plus({ days: 1 }).startOf('day').toUTC().toJSDate();
        const dailyCount = await client.query(
          `SELECT count(*)::int AS count FROM appointments
           WHERE business_id = $1 AND status != 'cancelled'
             AND start_time >= $2 AND start_time < $3`,
          [context.business.id, dayStart, dayEnd]
        );
        if (Number(dailyCount.rows[0].count) >= context.settings.booking_rules.maxPerDay) {
          const error = new Error('The daily booking limit has been reached');
          error.name = 'DailyBookingLimitError';
          throw error;
        }
      }
      const customerResult = await client.query(
        `INSERT INTO customers (business_id, full_name, phone_number, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id, phone_number)
         DO UPDATE SET full_name = EXCLUDED.full_name,
                       email = COALESCE(NULLIF(EXCLUDED.email, ''), customers.email)
         RETURNING id`,
        [context.business.id, name.trim(), phone, typeof email === 'string' ? email.trim() : null]
      );
      const customerId = customerResult.rows[0].id as string;
      const result = await client.query(
        `INSERT INTO appointments
           (business_id, customer_id, service_name, price, start_time, end_time, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'web', 'confirmed')
         RETURNING *`,
        [context.business.id, customerId, service.name, service.price, start, end]
      );
      const appointment = result.rows[0];
      await client.query(
        `INSERT INTO widget_booking_consents
           (business_id, customer_id, appointment_id, consent_version, website_origin)
         VALUES ($1, $2, $3, 'widget-booking-v1', $4)`,
        [context.business.id, customerId, appointment.id, req.get('origin')]
      );
      await client.query(
        'UPDATE customers SET last_visit_at = $1 WHERE id = $2',
        [start, customerId]
      );
      return { appointment, customerId };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === '23P01') {
      return res.status(409).json({ error: 'That time was just booked. Please choose another.' });
    }
    if ((error as Error)?.name === 'DailyBookingLimitError') {
      return res.status(409).json({ error: 'This business is fully booked for that day.' });
    }
    throw error;
  }

  const customerResult = await query(
    'SELECT full_name, phone_number, email FROM customers WHERE id = $1',
    [booking.customerId]
  );
  const customer = customerResult.rows[0];
  sendAppointmentConfirmation({
    businessId: context.business.id,
    customerId: booking.customerId,
    appointmentId: booking.appointment.id,
    businessName: context.business.name,
    customerName: customer.full_name,
    customerPhone: customer.phone_number,
    customerEmail: customer.email,
    serviceName: service.name,
    startTime: start.toISOString(),
    timezone: context.business.timezone,
  }).catch((error) => console.error('[widget/book] confirmation failed:', error));
  sendPushToBusinessMembers(
    context.business.id,
    'New website appointment',
    `${customer.full_name} - ${service.name} on ${DateTime.fromJSDate(start, {
      zone: context.business.timezone || 'UTC',
    }).toLocaleString(DateTime.DATETIME_MED)}`,
    { data: { appointmentId: booking.appointment.id } }
  ).catch((error) => console.error('[widget/book] push notification failed:', error));

  try {
    const eventId = await createCalendarEvent(context.business.id, {
      summary: `${service.name} - ${customer.full_name}`,
      description: `Booked via website chat. Customer phone: ${customer.phone_number}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    });
    if (eventId) {
      await query('UPDATE appointments SET calendar_event_id = $1 WHERE id = $2', [
        eventId,
        booking.appointment.id,
      ]);
    }
  } catch (error) {
    console.error('[widget/book] Google Calendar sync failed:', error);
  }
  res.status(201).json({
    appointment: {
      id: booking.appointment.id,
      service_name: service.name,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      status: 'confirmed',
    },
  });
});

router.post('/:businessId/contact', async (req, res) => {
  const context = res.locals.widgetContext as WidgetContext;
  if (!isRecord(req.body)) return res.status(400).json({ error: 'Invalid contact request.' });
  const { name, email, phone, message, consent } = req.body;
  const validEmail =
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const validPhone = typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone);
  if (
    typeof name !== 'string' ||
    name.trim().length < 2 ||
    name.trim().length > 120 ||
    (!validEmail && !validPhone) ||
    (email !== undefined && email !== '' && !validEmail) ||
    (phone !== undefined && phone !== '' && !validPhone) ||
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > 2000 ||
    consent !== true
  ) {
    return res.status(400).json({
      error: 'Enter your name, a valid email or phone number, a short message, and accept the privacy notice.',
    });
  }
  await query(
    `INSERT INTO widget_leads (business_id, name, email, phone, message, consent_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      context.business.id,
      name.trim(),
      validEmail ? email.trim() : null,
      validPhone ? phone.trim() : null,
      message.trim(),
    ]
  );
  if (context.settings.booking_rules.notifyEmail) {
    sendWidgetLeadNotification({
      to: context.settings.booking_rules.notifyEmail,
      businessName: context.business.name,
      name: name.trim(),
      email: validEmail ? email.trim() : null,
      phone: validPhone ? phone.trim() : null,
      message: message.trim(),
    }).catch((error) => console.error('[widget/contact] notification failed:', error));
  }
  res.status(201).json({ received: true });
});

export default router;
