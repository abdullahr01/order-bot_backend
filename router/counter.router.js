import express from 'express';

/**
 * /counter. The area guard has already checked the device token for everything except
 * /pair, which is rate-limited by IP instead (10 tries per 10 minutes).
 */
export class CounterRouter {
  #controller;

  constructor({ controller }) { this.#controller = controller; }

  build() {
    const router = express.Router();
    const c = this.#controller;
    router.post('/pair', c.pair);
    router.get('/session', c.session);
    router.post('/unlock', c.unlock);
    router.post('/lock', c.lock);
    return router;
  }
}
