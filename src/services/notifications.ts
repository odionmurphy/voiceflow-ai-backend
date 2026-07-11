import twilio from 'twilio';
import { query } from '../config/db';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
// onboarding@resend.dev works for testing without verifying your own domain.
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';

let twilioClient: ReturnType<typeof twilio> | null = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

export interface AppointmentConfirmationInput {
  businessId: string;
  customerId: string;
  appointmentId: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  serviceName: string | null;
  startTime: string; // ISO
}

function formatWhen(startTime: string): string {
  return new Date(startTime).toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function logMessage(params: {
  businessId: string;
  customerId: string;
  appointmentId: string;
  channel: 'sms' | 'email';
  template: 'confirmation' | 'cancellation' | 'reminder';
  body: string;
  status: 'sent' | 'failed';
}) {
  await query(
    `INSERT INTO messages (business_id, customer_id, appointment_id, channel, template, body, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.businessId,
      params.customerId,
      params.appointmentId,
      params.channel,
      params.template,
      params.body,
      params.status,
    ]
  );
}

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.warn('[notifications] Twilio not configured - skipping SMS');
    return false;
  }
  try {
    await twilioClient.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
    return true;
  } catch (err: any) {
    console.error('[notifications] SMS send failed:', err.message);
    return false;
  }
}

async function sendEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn('[notifications] Resend not configured - skipping email');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[notifications] Email send failed:', res.status, errText);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[notifications] Email send failed:', err.message);
    return false;
  }
}

// Sends SMS + email (whichever channels are configured/available) for a newly
// booked appointment, and logs each attempt to the messages table. Never throws -
// a notification failure should never roll back or fail the booking itself.
export async function sendAppointmentConfirmation(input: AppointmentConfirmationInput) {
  const when = formatWhen(input.startTime);
  const service = input.serviceName ? ` for ${input.serviceName}` : '';
  const smsBody = `${input.businessName}: Your appointment${service} is confirmed for ${when}. Reply if you need to reschedule.`;
  const emailBody = `Hi ${input.customerName},\n\nYour appointment${service} with ${input.businessName} is confirmed for ${when}.\n\nSee you then!`;

  const smsSent = await sendSms(input.customerPhone, smsBody);
  await logMessage({
    businessId: input.businessId,
    customerId: input.customerId,
    appointmentId: input.appointmentId,
    channel: 'sms',
    template: 'confirmation',
    body: smsBody,
    status: smsSent ? 'sent' : 'failed',
  });

  if (input.customerEmail) {
    const emailSent = await sendEmail(
      input.customerEmail,
      `Appointment confirmed - ${input.businessName}`,
      emailBody
    );
    await logMessage({
      businessId: input.businessId,
      customerId: input.customerId,
      appointmentId: input.appointmentId,
      channel: 'email',
      template: 'confirmation',
      body: emailBody,
      status: emailSent ? 'sent' : 'failed',
    });
  }
}

export interface AppointmentCancellationInput {
  businessId: string;
  customerId: string;
  appointmentId: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  serviceName: string | null;
  startTime: string; // ISO
}

// Mirrors sendAppointmentConfirmation: best-effort, logs every attempt, never throws -
// a notification failure should never roll back or fail the cancellation itself.
export async function sendAppointmentCancellation(input: AppointmentCancellationInput) {
  const when = formatWhen(input.startTime);
  const service = input.serviceName ? ` for ${input.serviceName}` : '';
  const smsBody = `${input.businessName}: Your appointment${service} on ${when} has been cancelled. Call us if you'd like to rebook.`;
  const emailBody = `Hi ${input.customerName},\n\nYour appointment${service} with ${input.businessName} on ${when} has been cancelled.\n\nGive us a call if you'd like to rebook.`;

  const smsSent = await sendSms(input.customerPhone, smsBody);
  await logMessage({
    businessId: input.businessId,
    customerId: input.customerId,
    appointmentId: input.appointmentId,
    channel: 'sms',
    template: 'cancellation',
    body: smsBody,
    status: smsSent ? 'sent' : 'failed',
  });

  if (input.customerEmail) {
    const emailSent = await sendEmail(
      input.customerEmail,
      `Appointment cancelled - ${input.businessName}`,
      emailBody
    );
    await logMessage({
      businessId: input.businessId,
      customerId: input.customerId,
      appointmentId: input.appointmentId,
      channel: 'email',
      template: 'cancellation',
      body: emailBody,
      status: emailSent ? 'sent' : 'failed',
    });
  }
}

export interface AppointmentReminderInput {
  businessId: string;
  customerId: string;
  appointmentId: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  serviceName: string | null;
  startTime: string; // ISO
}

// Mirrors sendAppointmentConfirmation/Cancellation: best-effort, logs every attempt,
// never throws - the reminder scan job never wants one bad send to abort the batch.
export async function sendAppointmentReminder(input: AppointmentReminderInput) {
  const when = formatWhen(input.startTime);
  const service = input.serviceName ? ` for ${input.serviceName}` : '';
  const smsBody = `${input.businessName}: Reminder - you have an appointment${service} on ${when}. Reply if you need to reschedule.`;
  const emailBody = `Hi ${input.customerName},\n\nJust a reminder that you have an appointment${service} with ${input.businessName} on ${when}.\n\nSee you then!`;

  const smsSent = await sendSms(input.customerPhone, smsBody);
  await logMessage({
    businessId: input.businessId,
    customerId: input.customerId,
    appointmentId: input.appointmentId,
    channel: 'sms',
    template: 'reminder',
    body: smsBody,
    status: smsSent ? 'sent' : 'failed',
  });

  if (input.customerEmail) {
    const emailSent = await sendEmail(
      input.customerEmail,
      `Appointment reminder - ${input.businessName}`,
      emailBody
    );
    await logMessage({
      businessId: input.businessId,
      customerId: input.customerId,
      appointmentId: input.appointmentId,
      channel: 'email',
      template: 'reminder',
      body: emailBody,
      status: emailSent ? 'sent' : 'failed',
    });
  }
}
