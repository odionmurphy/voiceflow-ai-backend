import { Router } from 'express';
import { query } from '../config/db';
import {
  constructWebhookEvent,
  planForPriceId,
  retrieveSubscription,
  PLAN_LIMITS,
  Stripe,
} from '../services/stripe';

const router = Router();

// Stripe's subscription status doesn't map 1:1 to ours - collapse the ones we don't
// distinguish (incomplete, unpaid, paused) into 'past_due' rather than adding more enum
// values our UI doesn't handle yet.
function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'canceled':
      return 'cancelled';
    case 'past_due':
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    default:
      return 'past_due';
  }
}

// POST /api/payments/webhook - Stripe calls this directly, no requireAuth. The signed
// payload (verified below) is the auth. Mounted with express.raw() in index.ts *before*
// the global express.json() middleware, since signature verification needs the raw bytes.
router.post('/', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return res.status(400).send('Missing Stripe-Signature header');
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(req.body as Buffer, signature);
  } catch (err: any) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = session.metadata?.businessId;
        const plan = session.metadata?.plan;
        if (!businessId || !plan) break;

        const subscriptionId = session.subscription as string;
        const sub = await retrieveSubscription(subscriptionId);

        await query(
          `UPDATE subscriptions
           SET plan = $1, status = $2, calls_included = $3,
               stripe_customer_id = $4, stripe_subscription_id = $5
           WHERE business_id = $6`,
          [
            plan,
            mapStripeStatus(sub.status),
            PLAN_LIMITS[plan] ?? null,
            session.customer as string,
            subscriptionId,
            businessId,
          ]
        );
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const item = sub.items.data[0];
        const priceId = item?.price?.id;
        const plan = planForPriceId(priceId);
        const periodEnd = new Date((item?.current_period_end ?? 0) * 1000);

        const fields = ['status = $1', 'current_period_end = $2', 'stripe_subscription_id = $3'];
        const params: any[] = [mapStripeStatus(sub.status), periodEnd, sub.id];
        if (plan) {
          fields.push(`plan = $${params.length + 1}`, `calls_included = $${params.length + 2}`);
          params.push(plan, PLAN_LIMITS[plan]);
        }
        params.push(sub.id, sub.customer as string);

        // Stripe doesn't guarantee webhook delivery order - this event can arrive
        // before checkout.session.completed has set stripe_subscription_id on the
        // row, in which case matching on it alone finds nothing and silently drops
        // the update (e.g. current_period_end never gets set). Falling back to
        // stripe_customer_id (set earlier, at checkout-session creation time) lets
        // this event claim the row and self-heal stripe_subscription_id regardless
        // of arrival order.
        await query(
          `UPDATE subscriptions SET ${fields.join(', ')}
           WHERE stripe_subscription_id = $${params.length - 1} OR stripe_customer_id = $${params.length}`,
          params
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await query(
          `UPDATE subscriptions SET status = 'cancelled' WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subDetails = invoice.parent?.subscription_details;
        const subscriptionId =
          typeof subDetails?.subscription === 'string'
            ? subDetails.subscription
            : subDetails?.subscription?.id ?? null;
        if (!subscriptionId) break;

        await query(
          `UPDATE subscriptions
           SET calls_used_this_period = 0, current_period_end = $1
           WHERE stripe_subscription_id = $2`,
          [new Date(invoice.period_end * 1000), subscriptionId]
        );
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subDetails = invoice.parent?.subscription_details;
        const subscriptionId =
          typeof subDetails?.subscription === 'string'
            ? subDetails.subscription
            : subDetails?.subscription?.id ?? null;
        if (!subscriptionId) break;

        await query(
          `UPDATE subscriptions SET status = 'past_due' WHERE stripe_subscription_id = $1`,
          [subscriptionId]
        );
        break;
      }

      default:
        console.log('[stripe webhook] unhandled event type:', event.type);
    }
  } catch (err: any) {
    // Log and still 200 - a DB hiccup shouldn't cause Stripe to hammer us with retries
    // for an event we've already accepted the signature on.
    console.error('[stripe webhook] handler error:', err.message);
  }

  res.json({ received: true });
});

export default router;
