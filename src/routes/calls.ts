import { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';

const router = Router();
router.use(requireAuth);

// GET /api/calls?businessId=...
router.get('/', async (req, res) => {
  const businessId = req.query.businessId as string;
  if (!businessId) return res.status(400).json({ error: 'businessId query param is required' });

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    `SELECT * FROM calls WHERE business_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [businessId]
  );
  res.json({ calls: result.rows });
});

const logCallSchema = z.object({
  businessId: z.string().uuid(),
  callerNumber: z.string().optional(),
  status: z.enum(['completed', 'missed', 'failed']).default('completed'),
  durationSeconds: z.number().default(0),
  intent: z.enum(['book', 'reschedule', 'cancel', 'faq', 'other']).optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  recordingUrl: z.string().url().optional(),
  customerId: z.string().uuid().optional(),
  resultedInAppointmentId: z.string().uuid().optional(),
});

// POST /api/calls - manual/external call logging. Note: voice-service (the actual AI
// call pipeline) does NOT call this - it writes directly to the shared Postgres DB
// (see voice-service/src/services/calls.ts). This route exists for any other client
// that wants to log a call through the API instead.
router.post('/', async (req, res) => {
  const parsed = logCallSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const f = parsed.data;

  const access = await getBusinessAccess(f.businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    `INSERT INTO calls (business_id, customer_id, caller_number, status, duration_seconds, intent, transcript, summary, recording_url, resulted_in_appointment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      f.businessId,
      f.customerId || null,
      f.callerNumber || null,
      f.status,
      f.durationSeconds,
      f.intent || null,
      f.transcript || null,
      f.summary || null,
      f.recordingUrl || null,
      f.resultedInAppointmentId || null,
    ]
  );
  res.status(201).json({ call: result.rows[0] });
});

export default router;
