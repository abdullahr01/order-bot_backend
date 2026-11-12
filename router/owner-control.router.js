import express from 'express';

/**
 * The owner's figures (figures.view) and account (account.manage): owners only, and an
 * unlocked counter only when the owner is the one at it. Reports lock from day 30 of
 * non-payment (the service checks the feature).
 */
export class OwnerControlRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    const { requirePermission, requireWritable } = this.#access;
    const figures = requirePermission('figures.view');
    const account = requirePermission('account.manage');

    router.get('/dashboard', figures, c.dashboard);
    router.get('/billing', account, c.billing);
    router.post('/upgrade-requests', account, c.ask);
    router.get('/void-log', figures, c.voidLog);
    router.get('/cash-close', figures, c.cashClose);
    router.post('/cash-close', figures, requireWritable, c.saveCashClose);
    router.get('/daily-summary', figures, c.dailySummary);
    router.get('/branches', figures, c.branches);
    router.get('/reports', figures, c.report);
    return router;
  }
}
