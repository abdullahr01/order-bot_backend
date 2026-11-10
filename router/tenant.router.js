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
    return router;
  }
}
