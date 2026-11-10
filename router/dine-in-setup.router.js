import express from 'express';

const QR_LOCKED = 'QR table ordering isn’t on your plan.';

/**
 * /portal/dine-in setup (guide 8.5). Tables are the owner's; waiters can also be managed
 * by branch staff and unlocked counters, who run the service.
 */
export class DineInSetupRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    const { requirePermission, requireFeature, requireSetupWritable, requireWritable } = this.#access;
    const qr = requireFeature('qr_ordering', QR_LOCKED);
    const tables = [requirePermission('tables.manage'), requireSetupWritable, qr];
    const waiters = [requirePermission('orders.manage'), requireWritable, qr];

    router.get('/dine-in/setup', requirePermission('orders.manage'), qr, c.get);
    router.post('/dine-in/tables', ...tables, c.addTable);
    router.patch('/dine-in/tables/:id', ...tables, c.updateTable);
    router.post('/dine-in/tables/:id/token', ...tables, c.replaceTableToken);
    router.post('/dine-in/waiters', ...waiters, c.addWaiter);
    router.delete('/dine-in/waiters/:id', ...waiters, c.removeWaiter);
    return router;
  }
}
