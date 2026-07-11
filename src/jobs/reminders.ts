import { query } from '../config/db';
import { sendAppointmentReminder } from '../services/notifications';

const LEAD_HOURS = Number(process.env.REMINDER_LEAD_HOURS || 24);
const POLL_MINUTES = Number(process.env.REMINDER_POLL_MINUTES || 15);

// Finds confirmed appointments starting within the next LEAD_HOURS that haven't
// already gotten a reminder, and sends one for each. Safe to call repeatedly - the
// "no reminder logged yet" check (rather than a fixed poll-aligned window) makes it
// idempotent even if a poll overlaps the previous one or the process restarts mid-window.
export async function scanAndSendReminders(): Promise<number> {
  const result = await query(
    `SELECT a.id, a.business_id, a.customer_id, a.service_name, a.start_time,
            b.name AS business_name,
            c.full_name AS customer_name, c.phone_number AS customer_phone, c.email AS customer_email
     FROM appointments a
     JOIN businesses b ON b.id = a.business_id
     JOIN customers c ON c.id = a.customer_id
     WHERE a.status = 'confirmed'
       AND a.start_time > now()
       AND a.start_time <= now() + ($1 * interval '1 hour')
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.appointment_id = a.id AND m.template = 'reminder'
       )`,
    [LEAD_HOURS]
  );

  for (const appt of result.rows) {
    try {
      await sendAppointmentReminder({
        businessId: appt.business_id,
        customerId: appt.customer_id,
        appointmentId: appt.id,
        businessName: appt.business_name,
        customerName: appt.customer_name,
        customerPhone: appt.customer_phone,
        customerEmail: appt.customer_email,
        serviceName: appt.service_name,
        startTime: appt.start_time,
      });
    } catch (err: any) {
      console.error('[reminders] failed for appointment', appt.id, err.message);
    }
  }

  return result.rows.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

// Starts the in-process poll loop. This is a single long-running Express process
// (no separate worker/queue), so setInterval is the whole "scheduler" - reaching for
// a job queue here would be infrastructure this app doesn't otherwise have.
export function startReminderScheduler() {
  if (timer) return;

  const run = () => {
    scanAndSendReminders()
      .then((count) => {
        if (count > 0) console.log(`[reminders] sent ${count} reminder(s)`);
      })
      .catch((err) => console.error('[reminders] scan failed:', err.message));
  };

  run();
  timer = setInterval(run, POLL_MINUTES * 60 * 1000);
}

export function stopReminderScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
