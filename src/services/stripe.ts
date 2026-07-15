import Stripe from 'stripe';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const TRIAL_DAYS = Number(process.env.STRIPE_TRIAL_DAYS || 14);

export const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  business: process.env.STRIPE_PRICE_BUSINESS || '',
};

export const PLAN_LIMITS: Record<string, number> = {
  starter: 100,
  professional: 500,
  business: Number.MAX_SAFE_INTEGER,
};

export function isStripeConfigured() {
  return !!SECRET_KEY;
}

// Lazy: constructing Stripe with an empty key throws immediately, and routes already
// check isStripeConfigured() before reaching any of the calls below - so we only need a
// real client once a key exists.
let _stripe: Stripe | null = null;
function client(): Stripe {
  if (!_stripe) _stripe = new Stripe(SECRET_KEY);
  return _stripe;
}

// Reverse-lookup: Stripe price ID -> our plan name, used when a webhook only gives us
// the price that's on the subscription (e.g. after a plan change in the Billing Portal).
export function planForPriceId(priceId: string | undefined): string | null {
  if (!priceId) return null;
  const entry = Object.entries(PLAN_PRICE_IDS).find(([, id]) => id === priceId);
  return entry ? entry[0] : null;
}

export async function getOrCreateCustomer(
  business: { id: string; name: string },
  ownerEmail: string,
  existingCustomerId: string | null
): Promise<string> {
  if (existingCustomerId) return existingCustomerId;

  const customer = await client().customers.create({
    email: ownerEmail,
    name: business.name,
    metadata: { businessId: business.id },
  });
  return customer.id;
}

export async function createCheckoutSession(params: {
  customerId: string;
  businessId: string;
  plan: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string | null> {
  const priceId = PLAN_PRICE_IDS[params.plan];
  if (!priceId) return null;

  const session = await client().checkout.sessions.create({
    mode: 'subscription',
    customer: params.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_period_days: TRIAL_DAYS },
    metadata: { businessId: params.businessId, plan: params.plan },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  });
  return session.url;
}

export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string
): Promise<string> {
  const session = await client().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  return client().webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

// The Checkout Session's `subscription` field is just an ID - fetching the full object
// gives us its real status (e.g. 'trialing'), which checkout.session.completed alone
// doesn't tell us.
export async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return client().subscriptions.retrieve(subscriptionId);
}

// Swaps the price on an *existing* subscription in place, rather than starting a new
// one - use this for plan changes once a subscription already exists. Running a fresh
// Checkout Session for an upgrade/downgrade would create a second, parallel subscription
// instead of replacing the first.
export async function changeSubscriptionPlan(
  subscriptionId: string,
  plan: string
): Promise<Stripe.Subscription> {
  const priceId = PLAN_PRICE_IDS[plan];
  const current = await client().subscriptions.retrieve(subscriptionId);
  const itemId = current.items.data[0].id;

  return client().subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: 'create_prorations',
  });
}

export type { Stripe };
