import { AuthRepository } from '../db/auth.repository.js';
import { EntitlementRepository } from '../db/entitlement.repository.js';
import { createAccessMiddleware } from '../middleware/access.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createRateLimits } from '../middleware/rate-limit.js';
import { settings } from '../shared/settings.js';
import { createTokenVerifier } from '../shared/token-verifier.js';
import { AuditService } from './audit.service.js';
import { AuthService } from './auth.service.js';
import { EntitlementService } from './entitlement.service.js';

/** Builds the shared services once, at startup. Nothing here holds per-request state. */
export function createServices({ database }) {
  const authRepository = new AuthRepository(database.sql);
  const authService = new AuthService({
    repository: authRepository,
    verifyToken: createTokenVerifier({ supabaseUrl: settings.supabase.url }),
  });
  const entitlements = new EntitlementService({ repository: new EntitlementRepository(database.sql) });
  return {
    database,
    entitlements,
    audit: new AuditService(),
    auth: createAuthMiddleware(authService),
    access: createAccessMiddleware({ entitlements, authRepository }),
    limits: createRateLimits(),
  };
}
