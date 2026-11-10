import express from 'express';

const QR_LOCKED = 'QR table ordering isn’t on your plan.';

/**
 * /portal/orders and the dine-in service routes: owner, branch staff and unlocked counters
 * (orders.manage). Changes are refused while the account is suspended; non-payment's day 30
 * doesn't stop the service.
 */
export class OrderRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    const { requirePermission, requireFeature, requireWritable } = this.#access;
    const staff = requirePermission('orders.manage');
    const qr = requireFeature('qr_ordering', QR_LOCKED);

    router.get('/orders', staff, c.list);
    router.get('/orders/:id', staff, c.get);
    router.patch('/orders/:id/status', staff, requireWritable, c.updateStatus);
    router.get('/dine-in/floor', staff, qr, c.floor);
    router.get('/dine-in/tables/:id', staff, qr, c.table);
    router.post('/dine-in/orders', staff, requireWritable, qr, c.addOrder);
    router.post('/dine-in/tables/:id/close', staff, requireWritable, qr, c.closeTable);
    router.get('/dine-in/requests', staff, qr, c.requests);
    router.post('/dine-in/requests/:id/handle', staff, requireWritable, qr, c.handleRequest);
    return router;
  }
}
