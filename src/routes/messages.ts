import { Router } from 'express';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';

const router = Router();
router.use(requireAuth);

// GET /api/messages?businessId=... - the SMS/email confirmation & cancellation log
router.get('/', async (req, res) => {
  const businessId = req.query.businessId as string;
  if (!businessId) return res.status(400).json({ error: 'businessId query param is required' });

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    `SELECT m.*, c.full_name AS customer_name
     FROM messages m
     LEFT JOIN customers c ON c.id = m.customer_id
     WHERE m.business_id = $1
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [businessId]
  );
  res.json({ messages: result.rows });
});

export default router;
