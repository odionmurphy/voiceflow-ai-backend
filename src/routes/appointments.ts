import { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';
import { sendAppointmentConfirmation, sendAppointmentCancellation } from '../services/notifications';
import { sendPushToBusinessMembers } from '../services/push';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../services/googleCalendar';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  businessId: z.string().uuid(),
  customerId: z.string().uuid(),
  serviceName: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  source: z.enum(['ai_call', 'manual', 'web']).default('manual'),
  staffId: z.string().uuid().optional(),
});

// GET /api/appointments?businessId=...&from=...&to=...
router.get('/', async (req, res) => {
  const businessId = req.query.businessId as string;
  if (!businessId) return res.status(400).json({ error: 'businessId query param is required' });

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const from = (req.query.from as string) || new Date(0).toISOString();
  const to = (req.query.to as string) || new Date('2100-01-01').toISOString();

  const result = await query(
    `SELECT a.*, c.full_name AS customer_name, c.phone_number AS customer_phone
     FROM appointments a
     JOIN customers c ON c.id = a.customer_id
     WHERE a.business_id = $1 AND a.start_time BETWEEN $2 AND $3
     ORDER BY a.start_time`,
    [businessId, from, to]
  );
  res.json({ appointments: result.rows });
});

// GET /api/appointments/availability?businessId=...&date=YYYY-MM-DD&durationMinutes=30&staffId=...
// Simple slot-finder: hours minus already-booked appointments for that day. Without
// staffId, uses the business's overall hours and its unassigned appointments (the
// original single-calendar behavior). With staffId, uses that staff member's own hours
// (falling back to the business's if they haven't set custom ones) and only that staff
// member's own appointments - so two staff can be double-booked against each other but
// never against themselves.
router.get('/availability', async (req, res) => {
  const businessId = req.query.businessId as string;
  const date = req.query.date as string; // YYYY-MM-DD
  const durationMinutes = Number(req.query.durationMinutes || 30);
  const staffId = (req.query.staffId as string) || null;

  if (!businessId || !date) {
    return res.status(400).json({ error: 'businessId and date query params are required' });
  }

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  const business = access.business;

  const dayOfWeek = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase().slice(0, 3);

  let hours = business.business_hours?.[dayOfWeek];
  if (staffId) {
    const memberResult = await query(
      'SELECT working_hours FROM business_members WHERE business_id = $1 AND user_id = $2',
      [businessId, staffId]
    );
    if (!memberResult.rows[0]) {
      return res.status(404).json({ error: 'Staff member not found on this business' });
    }
    const workingHours = memberResult.rows[0].working_hours;
    if (workingHours && Object.keys(workingHours).length > 0) {
      hours = workingHours[dayOfWeek];
    }
  }

  if (!hours) {
    return res.json({
      slots: [],
      note: staffId ? "This staff member isn't scheduled on this day" : 'Business closed on this day',
    });
  }

  const [openTime, closeTime] = hours;
  const dayStart = new Date(`${date}T${openTime}:00`);
  const dayEnd = new Date(`${date}T${closeTime}:00`);

  const existing = staffId
    ? await query(
        `SELECT start_time, end_time FROM appointments
         WHERE business_id = $1 AND staff_user_id = $2 AND start_time::date = $3 AND status != 'cancelled'
         ORDER BY start_time`,
        [businessId, staffId, date]
      )
    : await query(
        `SELECT start_time, end_time FROM appointments
         WHERE business_id = $1 AND staff_user_id IS NULL AND start_time::date = $2 AND status != 'cancelled'
         ORDER BY start_time`,
        [businessId, date]
      );
  const booked = existing.rows.map((r) => ({
    start: new Date(r.start_time),
    end: new Date(r.end_time),
  }));

  const slots: string[] = [];
  const stepMs = durationMinutes * 60 * 1000;
  for (let t = dayStart.getTime(); t + stepMs <= dayEnd.getTime(); t += stepMs) {
    const slotStart = new Date(t);
    const slotEnd = new Date(t + stepMs);
    const overlaps = booked.some((b) => slotStart < b.end && slotEnd > b.start);
    if (!overlaps) slots.push(slotStart.toISOString());
  }

  res.json({ slots });
});

// POST /api/appointments - books an appointment (rejects overlapping times)
router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, customerId, serviceName, startTime, endTime, source, staffId } = parsed.data;

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  const business = access.business;

  if (staffId) {
    const member = await query(
      'SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2',
      [businessId, staffId]
    );
    if (!member.rows[0]) {
      return res.status(400).json({ error: 'staffId is not a member of this business' });
    }
  }

  // Mirrors GET /availability's isolation: an unassigned booking only conflicts with
  // other unassigned bookings, a staff-assigned one only with that same staff member's.
  const conflict = staffId
    ? await query(
        `SELECT id FROM appointments
         WHERE business_id = $1 AND staff_user_id = $4 AND status != 'cancelled'
           AND start_time < $3 AND end_time > $2`,
        [businessId, startTime, endTime, staffId]
      )
    : await query(
        `SELECT id FROM appointments
         WHERE business_id = $1 AND staff_user_id IS NULL AND status != 'cancelled'
           AND start_time < $3 AND end_time > $2`,
        [businessId, startTime, endTime]
      );
  if (conflict.rows.length > 0) {
    return res.status(409).json({ error: 'This time slot overlaps an existing appointment' });
  }

  const result = await query(
    `INSERT INTO appointments (business_id, customer_id, staff_user_id, service_name, start_time, end_time, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed')
     RETURNING *`,
    [businessId, customerId, staffId || null, serviceName || null, startTime, endTime, source]
  );
  const appointment = result.rows[0];

  await query('UPDATE customers SET last_visit_at = $1 WHERE id = $2', [startTime, customerId]);

  // Fire the confirmation, but never let a notification failure block the booking response.
  const customerRow = await query('SELECT full_name, phone_number, email FROM customers WHERE id = $1', [
    customerId,
  ]);
  const customer = customerRow.rows[0];
  if (customer) {
    sendAppointmentConfirmation({
      businessId,
      customerId,
      appointmentId: appointment.id,
      businessName: business.name,
      customerName: customer.full_name,
      customerPhone: customer.phone_number,
      customerEmail: customer.email,
      serviceName: serviceName || null,
      startTime,
    }).catch((err) => console.error('[appointments] confirmation send failed:', err.message));

    sendPushToBusinessMembers(
      businessId,
      'New appointment booked',
      `${customer.full_name} - ${serviceName || 'Appointment'} on ${new Date(startTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      { data: { appointmentId: appointment.id }, excludeUserId: req.user!.userId }
    ).catch((err) => console.error('[appointments] push send failed:', err.message));

    // Best-effort: no-ops silently if this business hasn't connected a Google Calendar.
    const eventId = await createCalendarEvent(businessId, {
      summary: `${serviceName || 'Appointment'} - ${customer.full_name}`,
      description: `Booked via ${source}. Customer phone: ${customer.phone_number}`,
      startTime,
      endTime,
    });
    if (eventId) {
      await query('UPDATE appointments SET calendar_event_id = $1 WHERE id = $2', [
        eventId,
        appointment.id,
      ]);
      appointment.calendar_event_id = eventId;
    }
  }

  res.status(201).json({ appointment });
});

// PATCH /api/appointments/:id - reschedule or change status
router.patch('/:id', async (req, res) => {
  const existing = await query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  const appt = existing.rows[0];
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const access = await getBusinessAccess(appt.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Appointment not found' });

  const schema = z.object({
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
    serviceName: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const f = parsed.data;

  const result = await query(
    `UPDATE appointments SET
       start_time = COALESCE($1, start_time),
       end_time = COALESCE($2, end_time),
       status = COALESCE($3, status),
       service_name = COALESCE($4, service_name)
     WHERE id = $5
     RETURNING *`,
    [f.startTime ?? null, f.endTime ?? null, f.status ?? null, f.serviceName ?? null, req.params.id]
  );
  const updated = result.rows[0];

  if (appt.calendar_event_id && (f.startTime || f.endTime)) {
    await updateCalendarEvent(appt.business_id, appt.calendar_event_id, {
      startTime: updated.start_time,
      endTime: updated.end_time,
    });
  }

  res.json({ appointment: updated });
});

// DELETE /api/appointments/:id - cancels (soft delete via status)
router.delete('/:id', async (req, res) => {
  const existing = await query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  const appt = existing.rows[0];
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const access = await getBusinessAccess(appt.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Appointment not found' });

  const alreadyCancelled = appt.status === 'cancelled';
  await query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [req.params.id]);

  if (appt.calendar_event_id) {
    await deleteCalendarEvent(appt.business_id, appt.calendar_event_id);
  }

  // Fire the cancellation notice, but never let it block the response. Skip if it was
  // already cancelled, so re-hitting this endpoint doesn't re-notify the customer.
  if (!alreadyCancelled) {
    const customerRow = await query(
      'SELECT full_name, phone_number, email FROM customers WHERE id = $1',
      [appt.customer_id]
    );
    const customer = customerRow.rows[0];
    if (customer) {
      sendAppointmentCancellation({
        businessId: appt.business_id,
        customerId: appt.customer_id,
        appointmentId: appt.id,
        businessName: access.business.name,
        customerName: customer.full_name,
        customerPhone: customer.phone_number,
        customerEmail: customer.email,
        serviceName: appt.service_name,
        startTime: appt.start_time,
      }).catch((err) => console.error('[appointments] cancellation send failed:', err.message));
    }
  }

  res.status(204).send();
});

// DELETE /api/appointments/:id/permanent - owner-only. Hard-deletes the row (irreversible).
router.delete('/:id/permanent', async (req, res) => {
  const existing = await query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
  const appt = existing.rows[0];
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const access = await getBusinessAccess(appt.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Appointment not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can permanently delete an appointment' });
  }

  if (appt.calendar_event_id) {
    await deleteCalendarEvent(appt.business_id, appt.calendar_event_id);
  }

  await query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
  res.status(204).send();
});

export default router;
