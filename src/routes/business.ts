import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../config/db';
import { requireAuth } from '../middleware/auth';
import { getBusinessAccess, withRole } from '../middleware/ownership';

const router = Router();
router.use(requireAuth);

const businessSchema = z.object({
  name: z.string().min(1),
  industry: z.string().optional(),
  phoneNumber: z.string().optional(),
  timezone: z.string().default('Europe/Berlin'),
  address: z.string().optional(),
  businessHours: z.record(z.tuple([z.string(), z.string()])).optional(),
});

const aiSettingsSchema = z.object({
  greeting: z.string().optional(),
  voiceId: z.string().optional(),
  services: z
    .array(z.object({ name: z.string(), durationMinutes: z.number(), price: z.number() }))
    .optional(),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  bookingRules: z
    .object({
      minNoticeHours: z.number().optional(),
      bufferMinutes: z.number().optional(),
      maxPerDay: z.number().optional(),
      assistantName: z.string().optional(),
      forwardingNumber: z.string().optional(),
      notifyEmail: z.string().email().optional().or(z.literal("")),
      privacyPolicyUrl: z.string().optional(),
      language: z.string().optional(),
    })
    .optional(),
});

// GET /api/business - list businesses the current user is a member of (owner or staff)
router.get('/', async (req, res) => {
  const result = await query(
    `SELECT b.*, bm.role AS member_role
     FROM businesses b
     JOIN business_members bm ON bm.business_id = b.id
     WHERE bm.user_id = $1
     ORDER BY b.created_at`,
    [req.user!.userId]
  );
  const businesses = result.rows.map(({ member_role, ...b }) => withRole(b, member_role));
  res.json({ businesses });
});

// POST /api/business - create a new business + default AI settings + trial subscription + owner membership
router.post('/', async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, industry, phoneNumber, timezone, address, businessHours } = parsed.data;

  const business = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO businesses (owner_id, name, industry, phone_number, timezone, address, business_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user!.userId,
        name,
        industry || null,
        phoneNumber || null,
        timezone,
        address || null,
        JSON.stringify(businessHours || {}),
      ]
    );
    const biz = result.rows[0];

    await client.query('INSERT INTO ai_settings (business_id) VALUES ($1)', [biz.id]);
    await client.query(
      `INSERT INTO subscriptions (business_id, plan, status, calls_included)
       VALUES ($1, 'starter', 'trialing', 100)`,
      [biz.id]
    );
    await client.query(
      `INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [biz.id, req.user!.userId]
    );

    return biz;
  });

  res.status(201).json({ business: withRole(business, 'owner') });
});

// GET /api/business/:id
router.get('/:id', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  res.json({ business: withRole(access.business, access.role) });
});

// PATCH /api/business/:id - owner-only
router.patch('/:id', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can edit the business profile' });
  }

  const parsed = businessSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const fields = parsed.data;
  const result = await query(
    `UPDATE businesses SET
       name = COALESCE($1, name),
       industry = COALESCE($2, industry),
       phone_number = COALESCE($3, phone_number),
       timezone = COALESCE($4, timezone),
       address = COALESCE($5, address),
       business_hours = COALESCE($6, business_hours)
     WHERE id = $7
     RETURNING *`,
    [
      fields.name ?? null,
      fields.industry ?? null,
      fields.phoneNumber ?? null,
      fields.timezone ?? null,
      fields.address ?? null,
      fields.businessHours ? JSON.stringify(fields.businessHours) : null,
      req.params.id,
    ]
  );
  res.json({ business: withRole(result.rows[0], 'owner') });
});

// DELETE /api/business/:id - owner-only. Deletes the business and everything under it
// (customers, appointments, calls, messages, subscriptions, memberships - all cascade via FK)
router.delete('/:id', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can delete the business' });
  }

  await query('DELETE FROM businesses WHERE id = $1', [req.params.id]);
  res.status(204).send();
});

// GET /api/business/:id/ai-settings
router.get('/:id/ai-settings', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query('SELECT * FROM ai_settings WHERE business_id = $1', [req.params.id]);
  res.json({ aiSettings: result.rows[0] });
});

// PATCH /api/business/:id/ai-settings - owner-only
router.patch('/:id/ai-settings', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can edit AI settings' });
  }

  const parsed = aiSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const f = parsed.data;

  const result = await query(
    `UPDATE ai_settings SET
       greeting = COALESCE($1, greeting),
       voice_id = COALESCE($2, voice_id),
       services = COALESCE($3, services),
       faq = COALESCE($4, faq),
       booking_rules = COALESCE($5, booking_rules),
       updated_at = now()
     WHERE business_id = $6
     RETURNING *`,
    [
      f.greeting ?? null,
      f.voiceId ?? null,
      f.services ? JSON.stringify(f.services) : null,
      f.faq ? JSON.stringify(f.faq) : null,
      f.bookingRules ? JSON.stringify(f.bookingRules) : null,
      req.params.id,
    ]
  );
  res.json({ aiSettings: result.rows[0] });
});

// GET /api/business/:id/members - any member can view the team
router.get('/:id/members', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });

  const result = await query(
    `SELECT u.id AS user_id, u.email, u.full_name, bm.role, bm.working_hours, bm.created_at
     FROM business_members bm
     JOIN users u ON u.id = bm.user_id
     WHERE bm.business_id = $1
     ORDER BY bm.created_at`,
    [req.params.id]
  );
  res.json({ members: result.rows });
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.literal('staff'), // owners are only ever created via business creation, never invited
});

// POST /api/business/:id/members - owner-only. Adds an existing user as staff.
router.post('/:id/members', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can add team members' });
  }

  const parsed = addMemberSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { email, role } = parsed.data;

  const userResult = await query('SELECT id, email, full_name FROM users WHERE email = $1', [email]);
  const user = userResult.rows[0];
  if (!user) {
    return res.status(404).json({ error: 'No account found with that email - ask them to sign up first' });
  }

  const existing = await query(
    'SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2',
    [req.params.id, user.id]
  );
  if (existing.rows[0]) {
    return res.status(409).json({ error: 'That user is already a member of this business' });
  }

  await query(
    'INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, $3)',
    [req.params.id, user.id, role]
  );
  res.status(201).json({ member: { user_id: user.id, email: user.email, full_name: user.full_name, role } });
});

// DELETE /api/business/:id/members/:userId - owner-only. Cannot remove the last owner.
router.delete('/:id/members/:userId', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can remove team members' });
  }

  const target = await query(
    'SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2',
    [req.params.id, req.params.userId]
  );
  if (!target.rows[0]) {
    return res.status(404).json({ error: 'That user is not a member of this business' });
  }

  if (target.rows[0].role === 'owner') {
    const ownerCount = await query(
      "SELECT COUNT(*) FROM business_members WHERE business_id = $1 AND role = 'owner'",
      [req.params.id]
    );
    if (Number(ownerCount.rows[0].count) <= 1) {
      return res.status(400).json({ error: "Can't remove the last owner of a business" });
    }
  }

  await query('DELETE FROM business_members WHERE business_id = $1 AND user_id = $2', [
    req.params.id,
    req.params.userId,
  ]);
  res.status(204).send();
});

const workingHoursSchema = z.object({
  workingHours: z.record(z.tuple([z.string(), z.string()])),
});

// PATCH /api/business/:id/members/:userId/hours - owner-only. Sets a member's own
// working hours, distinct from the business's overall hours. An empty object clears it
// back to "no custom schedule - use the business's hours".
router.patch('/:id/members/:userId/hours', async (req, res) => {
  const access = await getBusinessAccess(req.params.id, req.user!.userId);
  if (!access) return res.status(404).json({ error: 'Business not found' });
  if (access.role !== 'owner') {
    return res.status(403).json({ error: 'Only the business owner can set staff working hours' });
  }

  const parsed = workingHoursSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await query(
    `UPDATE business_members SET working_hours = $1
     WHERE business_id = $2 AND user_id = $3
     RETURNING user_id, working_hours`,
    [JSON.stringify(parsed.data.workingHours), req.params.id, req.params.userId]
  );
  if (!result.rows[0]) {
    return res.status(404).json({ error: 'That user is not a member of this business' });
  }

  res.json({ member: result.rows[0] });
});

export default router;
