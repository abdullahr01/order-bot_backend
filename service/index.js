import express from 'express';
import { MenuController } from '../controller/menu.controller.js';
import { DineInSetupController } from '../controller/dine-in-setup.controller.js';
import { PortalController } from '../controller/portal.controller.js';
import { TenantController } from '../controller/tenant.controller.js';
import { SupabaseAuthAdmin } from '../db/auth-admin.js';
import { AuthRepository } from '../db/auth.repository.js';
import { DineInRepository } from '../db/dine-in.repository.js';
import { EntitlementRepository } from '../db/entitlement.repository.js';
import { MenuRepository } from '../db/menu.repository.js';
import { SupabasePhotoStorage } from '../db/photo-storage.js';
import { PortalRepository } from '../db/portal.repository.js';
import { SubscriptionRepository } from '../db/subscription.repository.js';
import { createSupabaseAdmin } from '../db/supabase.js';
import { TenantRepository } from '../db/tenant.repository.js';
import { createAccessMiddleware } from '../middleware/access.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createRateLimits } from '../middleware/rate-limit.js';
import { DineInSetupRouter } from '../router/dine-in-setup.router.js';
import { MenuRouter } from '../router/menu.router.js';
import { PortalRouter } from '../router/portal.router.js';
import { TenantRouter } from '../router/tenant.router.js';
import { settings } from '../shared/settings.js';
import { createTokenVerifier } from '../shared/token-verifier.js';
import { AuditService } from './audit.service.js';
import { AuthService } from './auth.service.js';
import { DineInSetupService } from './dine-in-setup.service.js';
import { EntitlementService } from './entitlement.service.js';
import { MenuService } from './menu.service.js';
import { PhotoService } from './photo.service.js';
import { PortalService } from './portal.service.js';
import { SubscriptionService } from './subscription.service.js';
import { TenantService } from './tenant.service.js';

/**
 * Builds the shared services once, at startup. Nothing here holds per-request state.
 * Tests pass their own token verifier, Auth admin and photo storage, so they never
 * create real Supabase accounts or files.
 */
export function createServices({ database, verifyToken, authAdmin, photoStorage, limits } = {}) {
  const sql = database.sql;
  let supabase;
  const client = () => (supabase ??= createSupabaseAdmin());

  const authRepository = new AuthRepository(sql);
  const tenantRepository = new TenantRepository(sql);
  const portalRepository = new PortalRepository(sql);
  const audit = new AuditService();
  const entitlements = new EntitlementService({ repository: new EntitlementRepository(sql) });
  const access = createAccessMiddleware({ entitlements, authRepository });
  const auth = createAuthMiddleware(new AuthService({
    repository: authRepository,
    verifyToken: verifyToken ?? createTokenVerifier({ supabaseUrl: settings.supabase.url }),
  }));

  const tenants = new TenantService({
    database, repository: tenantRepository, audit,
    authAdmin: authAdmin ?? new SupabaseAuthAdmin(client()), portalUrl: settings.portalUrl,
  });
  const subscriptions = new SubscriptionService({
    database, tenants: tenantRepository, repository: new SubscriptionRepository(), audit, tenantService: tenants,
  });
  const menu = new MenuService({ database, repository: new MenuRepository(sql), supabaseUrl: settings.supabase.url });
  const photos = new PhotoService({ storage: photoStorage ?? new SupabasePhotoStorage(client(), settings.supabase.url) });
  const dineInSetup = new DineInSetupService({ database, repository: new DineInRepository(sql), branches: portalRepository });

  const portal = express.Router();
  portal.use(new PortalRouter({ controller: new PortalController({ portal: new PortalService({ repository: portalRepository }), accessOf: access.accessOf }) }).build());
  portal.use(new MenuRouter({ controller: new MenuController({ menu, photos, accessOf: access.accessOf }), access }).build());
  portal.use(new DineInSetupRouter({ controller: new DineInSetupController({ setup: dineInSetup, accessOf: access.accessOf }), access }).build());

  return {
    database,
    entitlements,
    audit,
    auth,
    access,
    limits: limits ?? createRateLimits(),
    routers: {
      admin: new TenantRouter({ controller: new TenantController({ tenants, subscriptions, entitlements }), access }).build(),
      portal,
    },
  };
}
