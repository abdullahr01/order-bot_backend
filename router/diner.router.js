import express from 'express';

/**
 * /public/tables/:token: no sign-in. Reads are rate-limited per IP and table by the area
 * guard; orders and requests have per-party limits in the service.
 */
export class DinerRouter {
  #controller;

  constructor({ controller }) { this.#controller = controller; }

  build() {
    const router = express.Router();
    const c = this.#controller;
    router.get('/tables/:token', c.page);
    router.post('/tables/:token/orders', c.order);
    router.post('/tables/:token/requests', c.request);
    return router;
  }
}
