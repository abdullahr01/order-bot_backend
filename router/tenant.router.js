import express from 'express';

/**
 * /admin/tenants. The /admin guard has already checked the platform-team sign-in;
 * every /tenants/:id route also checks the restaurant is within the person's scope.
 */
export class TenantRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    router.get('/tenants', c.list);
    router.post('/tenants', c.create);
    router.use('/tenants/:id', this.#access.requireVisibleTenant);
    router.get('/tenants/:id', c.detail);
    router.patch('/tenants/:id', c.update);
    router.patch('/tenants/:id/onboarding', c.setOnboardingStep);
    router.post('/tenants/:id/plan', c.changePlan);
    router.delete('/tenants/:id/plan/scheduled', c.cancelScheduledChange);
    router.post('/tenants/:id/status', c.setStatus);
    router.post('/tenants/:id/payments', c.recordPayment);
    router.post('/tenants/:id/addons', c.addAddon);
    router.patch('/tenants/:id/addons/:addonId', c.setAddonQuantity);
    router.delete('/tenants/:id/addons/:addonId', c.removeAddon);
    // Granting access outside a plan is our own team's call, never a partner's.
    router.post('/tenants/:id/overrides', this.#access.requireNotPartner, c.createOverride);
    router.delete('/tenants/:id/overrides/:overrideId', this.#access.requireNotPartner, c.removeOverride);
    router.post('/tenants/:id/branches', c.addBranch);
    router.patch('/tenants/:id/branches/:branchId', c.updateBranch);
    router.delete('/tenants/:id/branches/:branchId', c.removeBranch);
    return router;
  }
}
