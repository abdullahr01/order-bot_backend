import express from 'express';

/**
 * /portal/team and /portal/counters: the owner only (team.manage). From day 30 of
 * non-payment, adding, editing and removing staff is refused, but PINs and counters
 * still work, so a forgotten PIN never stops the service (agreed 2026-11-10).
 */
export class TeamRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    const { requirePermission, requireSetupWritable, requireWritable } = this.#access;
    const owner = requirePermission('team.manage');

    router.get('/team', owner, c.get);
    router.post('/team', owner, requireSetupWritable, c.add);
    router.patch('/team/:id', owner, requireSetupWritable, c.update);
    router.delete('/team/:id', owner, requireSetupWritable, c.remove);
    router.put('/team/:id/pin', owner, requireWritable, c.setPin);
    router.get('/counters', owner, c.listCounters);
    router.post('/counters/pairing-codes', owner, requireWritable, c.createPairingCode);
    router.delete('/counters/:id', owner, requireWritable, c.revokeCounter);
    return router;
  }
}
