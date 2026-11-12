import express from 'express';

/**
 * /admin overview, price lists, upgrade requests, the monthly audit and partners. The
 * /admin guard has already checked the platform-team sign-in; each service applies the
 * country on screen and the person's scope (partners see only their own).
 */
export class ConsoleRouter {
  #controller;

  constructor({ controller }) { this.#controller = controller; }

  build() {
    const router = express.Router();
    const c = this.#controller;
    router.get('/dashboard', c.dashboard);
    router.get('/events', c.events);
    router.get('/requests', c.requests);
    router.post('/requests/:id/handle', c.handleRequest);
    router.get('/monthly-audit', c.audit);
    router.put('/monthly-audit/:month', c.updateAudit);
    router.get('/catalog', c.catalog);
    router.put('/catalog/plans/:planId', c.updatePlan);
    router.put('/catalog/addons/:addonId', c.updateAddon);
    router.get('/partners', c.partners);
    router.get('/partners/:id', c.partner);
    router.patch('/partners/:id', c.updatePartner);
    router.post('/partners/:id/statements/:month/received', c.recordPartnerPayment);
    return router;
  }
}
