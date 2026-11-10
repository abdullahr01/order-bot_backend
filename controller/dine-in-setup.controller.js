import { requestContext } from './context.js';

const MODULE = 'DineInSetupController';

/** Tables and waiters (guide 8.5). */
export class DineInSetupController {
  #setup;
  #accessOf;

  constructor({ setup, accessOf }) {
    this.#setup = setup;
    this.#accessOf = accessOf;
  }

  #handle(operation, call) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      context.log.info({ tenantId: request.actor.tenantId, ...(request.params.id ? { targetId: request.params.id } : {}) }, 'Dine-in setup request');
      response.json(await call(context, await this.#accessOf(request), request));
    };
  }

  get = this.#handle('get', (context, access) => this.#setup.setup(context, access));
  addTable = this.#handle('addTable', (context, access, request) => this.#setup.addTable(context, access, request.body));
  updateTable = this.#handle('updateTable', (context, access, request) => this.#setup.updateTable(context, access, request.params.id, request.body));
  replaceTableToken = this.#handle('replaceTableToken', (context, access, request) => this.#setup.replaceTableToken(context, access, request.params.id));
  addWaiter = this.#handle('addWaiter', (context, access, request) => this.#setup.addWaiter(context, access, request.body));
  removeWaiter = this.#handle('removeWaiter', (context, access, request) => this.#setup.removeWaiter(context, access, request.params.id));
}
