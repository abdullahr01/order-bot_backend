import express from 'express';

/** /portal/me: any restaurant user, and unlocked counters. */
export class PortalRouter {
  #controller;

  constructor({ controller }) { this.#controller = controller; }

  build() {
    const router = express.Router();
    router.get('/me', this.#controller.me);
    return router;
  }
}
