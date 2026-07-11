-- VoiceFlow AI - Database Schema (PostgreSQL)
-- Phase 1 MVP: auth, business profile, appointments, customers, calendar groundwork

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================
-- USERS (business owners / staff who log into the dashboard)
-- =========================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255),              -- nullable: OAuth-only users won't have one
    google_id       VARCHAR(255) UNIQUE,
    apple_id        VARCHAR(255) UNIQUE,
    full_name       VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'owner', -- owner | staff | admin
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- BUSINESSES (one owner can have multiple locations later)
-- =========================
CREATE TABLE businesses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    industry            VARCHAR(100),           -- dental, salon, barber, medical, auto, etc.
    phone_number        VARCHAR(50),            -- number customers call
    timezone            VARCHAR(100) NOT NULL DEFAULT 'Europe/Berlin',
    address             TEXT,
    business_hours      JSONB NOT NULL DEFAULT '{}', -- { "mon": ["09:00","18:00"], ... }
    subscription_plan   VARCHAR(50) NOT NULL DEFAULT 'starter', -- starter | professional | business
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_businesses_owner ON businesses(owner_id);

-- =========================
-- BUSINESS MEMBERS (per-business role: owner has full control, staff is restricted -
-- see backend/src/middleware/ownership.ts. Deliberately separate from users.role, which
-- is a vestigial site-wide column never read for authorization.)
-- =========================
CREATE TABLE IF NOT EXISTS business_members (
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'staff')),
    -- Same shape as businesses.business_hours ({"mon": ["09:00","18:00"], ...}). Empty/null
    -- means "no custom schedule set" - falls back to the business's own hours.
    working_hours   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id);

-- =========================
-- PUSH TOKENS (Expo push tokens, one row per device the user has logged into)
-- =========================
CREATE TABLE push_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(255) UNIQUE NOT NULL,
    platform    VARCHAR(20) NOT NULL DEFAULT 'unknown', -- ios | android
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- =========================
-- AI SETTINGS (per business: greeting, voice, FAQ, booking rules)
-- =========================
CREATE TABLE ai_settings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
    greeting        TEXT NOT NULL DEFAULT 'Hello! Thank you for calling. How can I help you today?',
    voice_id        VARCHAR(100) NOT NULL DEFAULT 'default',
    services        JSONB NOT NULL DEFAULT '[]',   -- [{ name, duration_minutes, price }]
    faq             JSONB NOT NULL DEFAULT '[]',   -- [{ question, answer }]
    booking_rules   JSONB NOT NULL DEFAULT '{}',   -- { min_notice_hours, buffer_minutes, max_per_day }
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- CUSTOMERS (per business)
-- =========================
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    phone_number    VARCHAR(50) NOT NULL,
    email           VARCHAR(255),
    notes           TEXT,
    last_visit_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, phone_number)
);

CREATE INDEX idx_customers_business ON customers(business_id);

-- =========================
-- APPOINTMENTS
-- =========================
CREATE TABLE appointments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Which staff member this is assigned to, if any. Null means unassigned - checked
    -- against the business's overall hours/conflicts rather than one staff member's.
    -- References users(id) (not business_members directly) since business_members' key
    -- is the (business_id, user_id) pair, not a standalone id.
    staff_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    service_name    VARCHAR(255),
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed | no_show
    source          VARCHAR(50) NOT NULL DEFAULT 'ai_call', -- ai_call | manual | web
    calendar_event_id VARCHAR(255),             -- external Google/Outlook event id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_appointments_business_time ON appointments(business_id, start_time);
CREATE INDEX idx_appointments_customer ON appointments(customer_id);
CREATE INDEX idx_appointments_staff ON appointments(staff_user_id, start_time);

-- =========================
-- CALLS (call history / recordings metadata)
-- =========================
CREATE TABLE calls (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
    caller_number       VARCHAR(50),
    direction           VARCHAR(20) NOT NULL DEFAULT 'inbound',
    status              VARCHAR(50) NOT NULL DEFAULT 'completed', -- completed | missed | failed
    duration_seconds    INTEGER DEFAULT 0,
    intent              VARCHAR(100),           -- book | reschedule | cancel | faq | other
    transcript          TEXT,
    summary             TEXT,                   -- short AI-generated summary of the call
    recording_url       TEXT,
    resulted_in_appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
    -- Set true when the caller wanted to book (intent='book') but the call ended without
    -- one - the automatic-follow-up job (voice-service/src/jobs/followups.ts) scans this.
    needs_followup      BOOLEAN NOT NULL DEFAULT false,
    followup_attempted_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calls_business ON calls(business_id, created_at);

-- Keeps subscriptions.calls_used_this_period accurate no matter which code path
-- inserts a call row (the backend's POST /api/calls, or voice-service's direct
-- INSERT into this table) - only 'completed' (answered) calls count against the
-- plan's quota, matching the "calls answered" stat shown in the dashboards.
CREATE OR REPLACE FUNCTION increment_calls_used()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'completed' THEN
        UPDATE subscriptions
        SET calls_used_this_period = calls_used_this_period + 1
        WHERE business_id = NEW.business_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calls_increment_usage AFTER INSERT ON calls
    FOR EACH ROW EXECUTE FUNCTION increment_calls_used();

-- =========================
-- MESSAGES (SMS/email confirmations sent out)
-- =========================
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
    appointment_id  UUID REFERENCES appointments(id) ON DELETE SET NULL,
    channel         VARCHAR(20) NOT NULL,       -- sms | email | push
    template        VARCHAR(100),               -- confirmation | reminder | cancellation
    body            TEXT,
    status          VARCHAR(50) NOT NULL DEFAULT 'sent', -- sent | failed | delivered
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_business ON messages(business_id, created_at);

-- =========================
-- SUBSCRIPTIONS (billing state, Stripe-style)
-- =========================
CREATE TABLE subscriptions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id             UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
    plan                    VARCHAR(50) NOT NULL DEFAULT 'starter',
    status                  VARCHAR(50) NOT NULL DEFAULT 'trialing', -- trialing | active | past_due | cancelled
    calls_included          INTEGER NOT NULL DEFAULT 100,
    calls_used_this_period  INTEGER NOT NULL DEFAULT 0,
    current_period_end      TIMESTAMPTZ,
    stripe_customer_id      VARCHAR(255),
    stripe_subscription_id  VARCHAR(255),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================
-- CALENDAR CONNECTIONS (Google/Outlook OAuth tokens per business)
-- =========================
CREATE TABLE calendar_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    provider        VARCHAR(50) NOT NULL,       -- google | outlook
    access_token    TEXT NOT NULL,
    refresh_token   TEXT,
    expires_at      TIMESTAMPTZ,
    calendar_id     VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (business_id, provider)
);

-- Trigger helper to keep updated_at fresh
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_businesses_updated_at BEFORE UPDATE ON businesses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appointments_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
