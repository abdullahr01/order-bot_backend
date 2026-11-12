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
import { CounterController } from '../controller/counter.controller.js';
import { DinerController } from '../controller/diner.controller.js';
import { OrderController } from '../controller/order.controller.js';
import { ServiceSettingsController } from '../controller/service-settings.controller.js';
import { TeamController } from '../controller/team.controller.js';
import { CounterRepository } from '../db/counter.repository.js';
import { IdempotencyRepository } from '../db/idempotency.repository.js';
import { OrderRepository } from '../db/order.repository.js';
import { ServiceSettingsRepository } from '../db/service-settings.repository.js';
import { TeamRepository } from '../db/team.repository.js';
import { CounterRouter } from '../router/counter.router.js';
import { DinerRouter } from '../router/diner.router.js';
import { OrderRouter } from '../router/order.router.js';
import { ServiceSettingsRouter } from '../router/service-settings.router.js';
import { TeamRouter } from '../router/team.router.js';
import { CounterService } from './counter.service.js';
import { DinerService } from './diner.service.js';
import { FloorService } from './floor.service.js';
import { IdempotencyService } from './idempotency.service.js';
import { OrderService } from './order.service.js';
import { ServiceRequestService } from './service-request.service.js';
import { ServiceSettingsService } from './service-settings.service.js';
import { TeamService } from './team.service.js';
import { ConsoleController } from '../controller/console.controller.js';
import { OwnerControlController } from '../controller/owner-control.controller.js';
import { BranchRepository } from '../db/branch.repository.js';
import { CatalogRepository } from '../db/catalog.repository.js';
import { ConsoleRepository } from '../db/console.repository.js';
import { OwnerRepository } from '../db/owner.repository.js';
import { PartnerRepository } from '../db/partner.repository.js';
import { ConsoleRouter } from '../router/console.router.js';
import { OwnerControlRouter } from '../router/owner-control.router.js';
import { BranchService } from './branch.service.js';
import { CatalogService } from './catalog.service.js';
import { ConsoleService } from './console.service.js';
import { OwnerControlService } from './owner-control.service.js';
import { PartnerService } from './partner.service.js';

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

  const accounts = authAdmin ?? new SupabaseAuthAdmin(client());
  const tenants = new TenantService({ database, repository: tenantRepository, audit, authAdmin: accounts, portalUrl: settings.portalUrl });
  const subscriptions = new SubscriptionService({
    database, tenants: tenantRepository, repository: new SubscriptionRepository(), audit, tenantService: tenants, entitlements,
  });
  const branches = new BranchService({ database, repository: new BranchRepository(), tenants: tenantRepository, tenantService: tenants, audit, entitlements });
  const menu = new MenuService({ database, repository: new MenuRepository(sql), supabaseUrl: settings.supabase.url });

  const photos = new PhotoService({ storage: photoStorage ?? new SupabasePhotoStorage(client(), settings.supabase.url) });
  const dineInSetup = new DineInSetupService({ database, repository: new DineInRepository(sql), branches: portalRepository });

  // Stage 4: the service day.
  const menuRepository = new MenuRepository(sql);
  const orderRepository = new OrderRepository(sql);
  const counters = new CounterService({ database, repository: new CounterRepository(sql), branches: portalRepository });
  const team = new TeamService({
    database, repository: new TeamRepository(sql), tenants: tenantRepository, branches: portalRepository,
    authAdmin: accounts, portalUrl: settings.portalUrl,
  });
  const idempotency = new IdempotencyService({ database, repository: new IdempotencyRepository() });
  const orders = new OrderService({ database, repository: orderRepository });
  const floor = new FloorService({ repository: orderRepository, menu: menuRepository, branches: portalRepository, idempotency });
  const serviceRequests = new ServiceRequestService({ database, repository: orderRepository, branches: portalRepository });
  const serviceSettings = new ServiceSettingsService({ database, repository: new ServiceSettingsRepository(sql) });
  const diner = new DinerService({ database, repository: orderRepository, menu: menuRepository, entitlements });

  const portal = express.Router();
  portal.use(new PortalRouter({ controller: new PortalController({ portal: new PortalService({ repository: portalRepository }), accessOf: access.accessOf }) }).build());
  portal.use(new MenuRouter({ controller: new MenuController({ menu, photos, accessOf: access.accessOf }), access }).build());
  portal.use(new DineInSetupRouter({ controller: new DineInSetupController({ setup: dineInSetup, accessOf: access.accessOf }), access }).build());
  portal.use(new TeamRouter({ controller: new TeamController({ team, counters, accessOf: access.accessOf }), access }).build());
  portal.use(new ServiceSettingsRouter({ controller: new ServiceSettingsController({ settings: serviceSettings }), access }).build());
  portal.use(new OrderRouter({ controller: new OrderController({ orders, floor, requests: serviceRequests, accessOf: access.accessOf }), access }).build());

  // Stage 5: owner figures, the rest of the console, partners.
  const catalogRepository = new CatalogRepository(sql);
  const consoleService = new ConsoleService({ database, repository: new ConsoleRepository(sql), tenants, catalogs: catalogRepository, entitlements });
  const catalog = new CatalogService({ database, repository: catalogRepository, audit });
  const partners = new PartnerService({ database, repository: new PartnerRepository(sql), audit });
  const owner = new OwnerControlService({ database, repository: new OwnerRepository(sql) });
  portal.use(new OwnerControlRouter({ controller: new OwnerControlController({ owner, console: consoleService, accessOf: access.accessOf }), access }).build());

  const admin = express.Router();
  admin.use(new TenantRouter({ controller: new TenantController({ tenants, subscriptions, entitlements, branches }), access }).build());
  admin.use(new ConsoleRouter({ controller: new ConsoleController({ console: consoleService, catalog, partners }) }).build());

  return {
    database,
    entitlements,
    audit,
    auth,
    access,
    limits: limits ?? createRateLimits(),
    routers: {
      admin,
      portal,
      counter: new CounterRouter({ controller: new CounterController({ counters }) }).build(),
      public: new DinerRouter({ controller: new DinerController({ diner }) }).build(),
    },
  };
}
