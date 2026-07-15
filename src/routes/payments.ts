import { Router } from 'express';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';
import {
  PLAN_LIMITS,
  getOrCreateCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  changeSubscriptionPlan,
  isStripeConfigured,
} from '../services/stripe';

// A subscription row only represents a *live* Stripe subscription (one that can be
// changed in place) once it has both a Stripe id and hasn't been cancelled.
function hasLiveStripeSubscription(subscription: any): boolean {
  return !!subscription?.stripe_subscription_id && subscription.status !== 'cancelled';
}

const router = Router();
router.use(requireAuth);

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';

// GET /api/payments/:businessId/subscription - owner-only (staff has no billing access)
router.get('/:businessId/subscription', async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can view billing details' });
  }

  const result = await query('SELECT * FROM subscriptions WHERE business_id = $1', [
    req.params.businessId,
  ]);
  res.json({ subscription: result.rows[0] });
});

// POST /api/payments/:businessId/checkout-session - owner-only. Starts (or restarts) a
// paid Stripe subscription for the given plan via Stripe Checkout.
router.post('/:businessId/checkout-session', async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can manage billing' });
  }
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: 'Stripe is not configured yet. Set STRIPE_SECRET_KEY in .env' });
  }

  const plan = req.body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return res.status(400).json({ error: 'plan must be one of starter, professional, business' });
  }

  const subResult = await query('SELECT * FROM subscriptions WHERE business_id = $1', [
    req.params.businessId,
  ]);
  const subscription = subResult.rows[0];

  if (hasLiveStripeSubscription(subscription)) {
    return res.status(409).json({
      error: 'A subscription is already active - use change-plan to switch plans instead of starting a new checkout',
    });
  }

  const userResult = await query('SELECT email FROM users WHERE id = $1', [req.user!.userId]);
  const ownerEmail = userResult.rows[0]?.email as string;

  try {
    const customerId = await getOrCreateCustomer(
      access.business,
      ownerEmail,
      subscription?.stripe_customer_id ?? null
    );

    if (subscription && subscription.stripe_customer_id !== customerId) {
      await query('UPDATE subscriptions SET stripe_customer_id = $1 WHERE business_id = $2', [
        customerId,
        req.params.businessId,
      ]);
    }

    const url = await createCheckoutSession({
      customerId,
      businessId: req.params.businessId,
      plan,
      successUrl: `${CLIENT_ORIGIN}/dashboard/settings?billing=success`,
      cancelUrl: `${CLIENT_ORIGIN}/dashboard/settings?billing=cancelled`,
    });
    if (!url) {
      return res.status(500).json({ error: `No Stripe price configured for plan "${plan}"` });
    }

    res.json({ url });
  } catch (err: any) {
    console.error('[stripe] checkout-session failed', err);
    res.status(502).json({ error: 'Stripe request failed - please try again later' });
  }
});

// POST /api/payments/:businessId/change-plan - owner-only. Switches the price on the
// existing live subscription in place, instead of starting a second parallel one.
router.post('/:businessId/change-plan', async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can manage billing' });
  }
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: 'Stripe is not configured yet. Set STRIPE_SECRET_KEY in .env' });
  }

  const plan = req.body.plan as string;
  if (!plan || !(plan in PLAN_LIMITS)) {
    return res.status(400).json({ error: 'plan must be one of starter, professional, business' });
  }

  const subResult = await query('SELECT * FROM subscriptions WHERE business_id = $1', [
    req.params.businessId,
  ]);
  const subscription = subResult.rows[0];
  if (!hasLiveStripeSubscription(subscription)) {
    return res.status(400).json({ error: 'No active subscription to change - choose a plan to start one' });
  }

  try {
    const updated = await changeSubscriptionPlan(subscription.stripe_subscription_id, plan);

    const result = await query(
      `UPDATE subscriptions SET plan = $1, calls_included = $2 WHERE business_id = $3 RETURNING *`,
      [plan, PLAN_LIMITS[plan], req.params.businessId]
    );
    res.json({ subscription: result.rows[0], stripeStatus: updated.status });
  } catch (err: any) {
    console.error('[stripe] change-plan failed', err);
    const status = err?.statusCode === 429 ? 429 : 502;
    const message =
      err?.statusCode === 429
        ? 'Stripe rate limit reached for this subscription - please wait a bit before changing plans again'
        : 'Stripe request failed - please try again later';
    res.status(status).json({ error: message });
  }
});

// POST /api/payments/:businessId/billing-portal - owner-only. Opens the Stripe Billing
// Portal so the owner can update payment method, change plan, or cancel.
router.post('/:businessId/billing-portal', async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can manage billing' });
  }
  if (!isStripeConfigured()) {
    return res.status(501).json({ error: 'Stripe is not configured yet. Set STRIPE_SECRET_KEY in .env' });
  }

  const subResult = await query('SELECT stripe_customer_id FROM subscriptions WHERE business_id = $1', [
    req.params.businessId,
  ]);
  const customerId = subResult.rows[0]?.stripe_customer_id;
  if (!customerId) {
    return res.status(400).json({ error: 'No billing account yet - start a subscription first' });
  }

  try {
    const url = await createBillingPortalSession(
      customerId,
      `${CLIENT_ORIGIN}/dashboard/settings`
    );
    res.json({ url });
  } catch (err) {
    console.error('[stripe] billing-portal failed', err);
    res.status(502).json({ error: 'Stripe request failed - please try again later' });
  }
});

export default router;
