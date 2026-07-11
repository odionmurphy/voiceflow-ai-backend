import { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess } from '../middleware/ownership';

const router = Router();
router.use(requireAuth);

const customerSchema = z.object({
  businessId: z.string().uuid(),
  fullName: z.string().min(1),
  phoneNumber: z.string().min(3),
  email: z.string().email().optional(),
  notes: z.string().optional(),
});

// GET /api/customers?businessId=...
router.get('/', async (req, res) => {
  const businessId = req.query.businessId as string;
  if (!businessId) return res.status(400).json({ error: 'businessId query param is required' });

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    'SELECT * FROM customers WHERE business_id = $1 ORDER BY full_name',
    [businessId]
  );
  res.json({ customers: result.rows });
});

// POST /api/customers
router.post('/', async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { businessId, fullName, phoneNumber, email, notes } = parsed.data;

  const access = await getBusinessAccess(businessId, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  // Upsert on (business_id, phone_number) so repeat callers don't create duplicates
  const result = await query(
    `INSERT INTO customers (business_id, full_name, phone_number, email, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, phone_number)
     DO UPDATE SET full_name = EXCLUDED.full_name, email = COALESCE(EXCLUDED.email, customers.email)
     RETURNING *`,
    [businessId, fullName, phoneNumber, email || null, notes || null]
  );
  res.status(201).json({ customer: result.rows[0] });
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  const result = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  const customer = result.rows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const access = await getBusinessAccess(customer.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Customer not found' });

  res.json({ customer });
});

// PATCH /api/customers/:id
router.patch('/:id', async (req, res) => {
  const existing = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  const customer = existing.rows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const access = await getBusinessAccess(customer.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Customer not found' });

  const parsed = customerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const f = parsed.data;

  const result = await query(
    `UPDATE customers SET
       full_name = COALESCE($1, full_name),
       phone_number = COALESCE($2, phone_number),
       email = COALESCE($3, email),
       notes = COALESCE($4, notes)
     WHERE id = $5
     RETURNING *`,
    [f.fullName ?? null, f.phoneNumber ?? null, f.email ?? null, f.notes ?? null, req.params.id]
  );
  res.json({ customer: result.rows[0] });
});

// DELETE /api/customers/:id - owner-only
router.delete('/:id', async (req, res) => {
  const existing = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  const customer = existing.rows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const access = await getBusinessAccess(customer.business_id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Customer not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can delete a customer' });
  }

  await query('DELETE FROM customers WHERE id = $1', [req.params.id]);
  res.status(204).send();
});

export default router;
