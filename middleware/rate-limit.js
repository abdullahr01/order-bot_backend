import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { apiError } from '../shared/error-codes.js';

const MINUTE = 60_000;

function limiter({ limit, windowMs, key, message }) {
  return rateLimit({
    limit, windowMs, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: key,
    handler: (_request, _response, next) => next(apiError('rate_limited', message)),
  });
}

// Guide section 13. Order, request and PIN limits count database rows, so they live
// with those endpoints. These counters are per process: fine for one server.
export function createRateLimits({
  dinerReads = { limit: 60, windowMs: MINUTE },
  pairing = { limit: 10, windowMs: 10 * MINUTE },
} = {}) {
  return {
    dinerReads: limiter({
      ...dinerReads,
      key: (request) => `${ipKeyGenerator(request.ip)}:${request.params.token}`,
      message: 'Too many requests. Please wait a moment and try again.',
    }),
    pairing: limiter({
      ...pairing,
      key: (request) => ipKeyGenerator(request.ip),
      message: 'Too many tries. Please wait a few minutes and try again.',
    }),
  };
}
