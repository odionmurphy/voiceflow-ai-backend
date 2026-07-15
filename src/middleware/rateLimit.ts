import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { Request, Response, NextFunction } from 'express';

// Render runs this service across multiple instances, each with its own process
// memory - an in-memory rate limiter (e.g. plain express-rate-limit) keeps a separate
// counter per instance, so a client's requests get split across several buckets
// instead of one shared count and the limit never actually triggers. Upstash's REST-
// based Redis gives every instance a single shared counter over plain HTTPS, with no
// persistent connection to manage.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

if (!redis) {
  // eslint-disable-next-line no-console
  console.warn(
    '[rateLimit] UPSTASH_REDIS_REST_URL/TOKEN not set - rate limiting is disabled, not silently broken.'
  );
}

type Duration = `${number} ${'ms' | 's' | 'm' | 'h' | 'd'}`;

export function createRateLimiter(prefix: string, limit: number, window: Duration) {
  const ratelimit = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, window),
        prefix: `ratelimit:${prefix}`,
      })
    : null;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    // Fails open (not "silently unlimited by accident") - if Upstash isn't configured
    // at all this is a deliberate choice (e.g. local dev without an Upstash account),
    // logged once above at startup rather than per-request.
    if (!ratelimit) return next();

    const { success, limit: max, remaining, reset } = await ratelimit.limit(
      req.ip || 'unknown'
    );
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((reset - Date.now()) / 1000))));

    if (!success) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}
