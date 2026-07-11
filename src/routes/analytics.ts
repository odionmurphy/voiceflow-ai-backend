import { Router } from 'express';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';

const router = Router();
router.use(requireAuth);

// GET /api/analytics/:businessId?days=30 - call/appointment trends beyond "today"
router.get('/:businessId', async (req, res) => {
  const access = await getBusinessAccess(req.params.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = to.toISOString().slice(0, 10);

  const dailyResult = await query(
    `WITH days AS (
       SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day
     ),
     call_daily AS (
       SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*) FILTER (WHERE status = 'completed') AS answered,
              COUNT(*) FILTER (WHERE status = 'missed') AS missed
       FROM calls
       WHERE business_id = $1 AND created_at >= $2::date AND created_at < $3::date + interval '1 day'
       GROUP BY 1
     ),
     appt_daily AS (
       SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*) AS booked
       FROM appointments
       WHERE business_id = $1 AND created_at >= $2::date AND created_at < $3::date + interval '1 day'
       GROUP BY 1
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
            COALESCE(call_daily.answered, 0)::int AS calls_answered,
            COALESCE(call_daily.missed, 0)::int AS calls_missed,
            COALESCE(appt_daily.booked, 0)::int AS appointments_booked
     FROM days
     LEFT JOIN call_daily ON call_daily.day = days.day
     LEFT JOIN appt_daily ON appt_daily.day = days.day
     ORDER BY days.day`,
    [req.params.businessId, fromDate, toDate]
  );

  const callTotalsResult = await query(
    `SELECT
       COUNT(*)::int AS calls_total,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS calls_answered,
       COUNT(*) FILTER (WHERE status = 'missed')::int AS calls_missed
     FROM calls
     WHERE business_id = $1 AND created_at >= $2::date AND created_at < $3::date + interval '1 day'`,
    [req.params.businessId, fromDate, toDate]
  );

  // Appointments are bucketed by start_time here (not created_at) - this measures what
  // actually happened in the period, which is what a no-show/cancellation rate means.
  const apptTotalsResult = await query(
    `SELECT
       COUNT(*)::int AS appointments_total,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS appointments_completed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS appointments_cancelled,
       COUNT(*) FILTER (WHERE status = 'no_show')::int AS appointments_no_show
     FROM appointments
     WHERE business_id = $1 AND start_time >= $2::date AND start_time < $3::date + interval '1 day'`,
    [req.params.businessId, fromDate, toDate]
  );

  const callTotals = callTotalsResult.rows[0];
  const apptTotals = apptTotalsResult.rows[0];
  const answerRate =
    callTotals.calls_total > 0 ? callTotals.calls_answered / callTotals.calls_total : null;
  const noShowRate =
    apptTotals.appointments_total > 0
      ? apptTotals.appointments_no_show / apptTotals.appointments_total
      : null;

  res.json({
    range: { from: fromDate, to: toDate, days },
    totals: { ...callTotals, ...apptTotals, answerRate, noShowRate },
    daily: dailyResult.rows,
  });
});

export default router;
