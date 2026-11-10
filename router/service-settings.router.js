import express from 'express';

/** /portal/service (owner) and /portal/today (owner, staff and counters). */
export class ServiceSettingsRouter {
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
    router.get('/service', requirePermission('service.hours'), c.get);
    router.patch('/service', requirePermission('service.hours'), requireWritable, c.update);
    router.get('/today', requirePermission('service.pause'), c.today);
    router.put('/today/pause', requirePermission('service.pause'), requireWritable, c.pauseBranch);
    return router;
  }
}
