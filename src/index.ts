import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import analyticsRoutes from './routes/analytics';
import authRoutes from './routes/auth';
import businessRoutes from './routes/business';
import customerRoutes from './routes/customers';
import appointmentRoutes from './routes/appointments';
import callRoutes from './routes/calls';
import calendarRoutes from './routes/calendar';
import messageRoutes from './routes/messages';
import paymentRoutes from './routes/payments';
import stripeWebhookRoutes from './routes/webhook';
import { startReminderScheduler } from './jobs/reminders';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
    credentials: true,
  })
);

// Stripe webhook needs the raw request body for signature verification, so it must be
// mounted before the global express.json() parser consumes the stream.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'voiceflow-ai-backend' }));

app.use('/api/analytics', analyticsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payments', paymentRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`VoiceFlow AI backend listening on http://localhost:${PORT}`);
  startReminderScheduler();
});

export default app;
