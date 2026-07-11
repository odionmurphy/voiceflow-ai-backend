# VoiceFlow AI — Backend

An AI receptionist platform: answers business calls 24/7, books appointments, answers FAQs,
and syncs with the business's calendar. All four roadmap phases are now built: auth/business
profiles/appointments (Phase 1), the Twilio+Gemini voice pipeline and Google Calendar sync
(Phase 2, in `../voice-service`), SMS/email confirmations + reminders + analytics (Phase 3),
and Stripe billing (Phase 4).

## Stack
- Node.js + Express + TypeScript
- PostgreSQL (raw `pg`, no ORM — keeps the schema fully visible in `src/db/schema.sql`)
- JWT auth (email/password now; Google/Apple OAuth slots are in the `users` table schema,
  ready to wire up)
- Zod for request validation

## Project structure
```
backend/
  src/
    index.ts            # Express app entry point
    config/db.ts         # Postgres pool
    db/schema.sql         # Full schema (users, businesses, customers, appointments, calls, ...)
    db/migrate.ts         # Applies schema.sql to DATABASE_URL
    middleware/auth.ts     # JWT sign/verify
    middleware/ownership.ts # Confirms a business belongs to the logged-in user
    jobs/
      reminders.ts          # in-process poll loop: sends appointment reminders ~24h ahead
    services/
      notifications.ts       # SMS (Twilio) + email (Resend) sends, logs to `messages`
      stripe.ts               # Checkout Sessions, Billing Portal, plan changes
      googleCalendar.ts        # Google Calendar OAuth + event CRUD
    routes/
      auth.ts             # register, login, me
      business.ts          # business profile + AI settings (greeting, FAQ, services, booking rules)
      customers.ts          # customer CRUD, upserts by phone number
      appointments.ts        # booking, availability slots, reschedule, cancel
      calls.ts               # call history logging (voice-service posts here)
      calendar.ts             # Google Calendar OAuth connect + status
      messages.ts              # SMS/email message log (confirmation/cancellation/reminder)
      analytics.ts              # call/appointment trends beyond "today"
      payments.ts                # subscription plan + Stripe Checkout/Billing Portal
```

## Local setup

```bash
cd backend
npm install
cp .env.example .env        # then fill in DATABASE_URL and JWT_SECRET at minimum
```

You'll need a Postgres database. Easiest options:
- Local: `sudo apt install postgresql` then `createdb voiceflow_ai`
- Hosted (matches your Vercel deploy pattern): Neon, Supabase, or Render Postgres — free tiers
  all work for MVP testing.

Apply the schema:
```bash
npm run migrate
```

Run the dev server:
```bash
npm run dev
# -> http://localhost:4000/health should return {"status":"ok"}
```

## API quick reference

All routes except `/health`, `/api/auth/register`, `/api/auth/login` require:
`Authorization: Bearer <token>` (returned from register/login).

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account, returns JWT |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/business` | List / create businesses |
| GET/PATCH | `/api/business/:id` | Business profile |
| GET/PATCH | `/api/business/:id/ai-settings` | Greeting, services, FAQ, booking rules |
| GET/POST | `/api/customers?businessId=` | List / upsert customers |
| GET/PATCH/DELETE | `/api/customers/:id` | Single customer |
| GET | `/api/appointments?businessId=&from=&to=` | List appointments in range |
| GET | `/api/appointments/availability?businessId=&date=&durationMinutes=` | Open slots for a day |
| POST | `/api/appointments` | Book (rejects overlaps) |
| PATCH/DELETE | `/api/appointments/:id` | Reschedule / cancel |
| GET/POST | `/api/calls?businessId=` | Call history (voice-service writes here) |
| GET | `/api/calendar/:businessId/status` | Connected calendars |
| GET | `/api/calendar/:businessId/google/connect` | Start Google OAuth (needs client ID/secret) |
| DELETE | `/api/calendar/:businessId/google` | Disconnect Google Calendar |
| GET | `/api/messages?businessId=` | SMS/email message log (confirmation/cancellation/reminder, sent/failed) |
| GET | `/api/analytics/:businessId?days=` | Call/appointment trends + totals for the last N days (default 30) |
| GET | `/api/payments/:businessId/subscription` | Plan + usage |
| POST | `/api/payments/:businessId/checkout-session` | Start a Stripe Checkout session for a plan |
| POST | `/api/payments/:businessId/change-plan` | Swap the price on an existing live subscription |
| POST | `/api/payments/:businessId/billing-portal` | Open the Stripe Billing Portal |

## Deploying (same pattern as your other client demos)
- Backend: Vercel (Node serverless) or Render — either works with this Express app.
  If Vercel: add a `vercel.json` with a rewrite to `src/index.ts`, and remember Postgres
  connection pooling matters more on serverless (consider `pg` pool `max: 1` or a pooled
  provider like Neon/Supabase's pgbouncer endpoint).
- **CORS reminder from your other builds still applies here**: if you ever add a
  browser-side caller that isn't this backend (e.g. a marketing page hitting the API
  directly), route it through a serverless proxy — never `mode: 'no-cors'`.

## Roadmap status
- **Phase 2** (done, `../voice-service`): Twilio Voice + Gemini handle the call, then POST
  the result to `/api/calls`. Google Calendar OAuth connect/sync lives in this backend
  (`routes/calendar.ts`, `services/googleCalendar.ts`).
- **Phase 3** (done): booking confirmation, cancellation, and ~24h-ahead reminder
  SMS/email all go through `services/notifications.ts` and land in `/api/messages`.
  Reminders are sent by an in-process poll loop (`jobs/reminders.ts`, no external queue),
  configurable via `REMINDER_LEAD_HOURS` / `REMINDER_POLL_MINUTES`. `/api/analytics`
  covers the trend/rate reporting piece.
- **Phase 4** (done): Stripe Checkout, Billing Portal, and plan changes wired into
  `/api/payments` (`services/stripe.ts`), webhooks in `routes/webhook.ts`.

Natural next additions, not yet built: revenue tracking on the Overview dashboard
(per-appointment revenue from `ai_settings.services[].price` × completed appointments),
surfacing call transcripts/recordings in the UI (the data's already in `calls`).

## Testing the API without a frontend yet
```bash
# Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"supersecret1","fullName":"Murphy"}'

# Save the returned token, then create a business
curl -X POST http://localhost:4000/api/business \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Bright Smile Dental","industry":"dental","timezone":"Europe/Berlin","businessHours":{"mon":["09:00","18:00"]}}'
```
