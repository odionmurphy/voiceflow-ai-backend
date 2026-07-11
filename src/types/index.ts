export interface AuthTokenPayload {
  userId: string;
  email: string;
}

// Per-business membership role - distinct from the vestigial users.role column, which is
// never read for authorization. A user can be 'owner' on one business and 'staff' on another.
export type BusinessMemberRole = 'owner' | 'staff';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: 'owner' | 'staff' | 'admin';
  created_at: string;
}

export interface Business {
  id: string;
  owner_id: string;
  name: string;
  industry: string | null;
  phone_number: string | null;
  timezone: string;
  address: string | null;
  business_hours: Record<string, [string, string]>;
  subscription_plan: 'starter' | 'professional' | 'business';
  role?: BusinessMemberRole;
}

export interface Customer {
  id: string;
  business_id: string;
  full_name: string;
  phone_number: string;
  email: string | null;
  notes: string | null;
  last_visit_at: string | null;
}

export interface Appointment {
  id: string;
  business_id: string;
  customer_id: string;
  service_name: string | null;
  start_time: string;
  end_time: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  source: 'ai_call' | 'manual' | 'web';
  calendar_event_id: string | null;
}

// Augment Express Request to carry the authenticated user
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}
