import { IdempotencyService } from '../service/idempotency.service.js';
import { requestContext } from './context.js';

const MODULE = 'OrderController';

/** Orders, the floor, settling tables and diner requests (guide 8.2-8.4). */
export class OrderController {
  #orders;
  #floor;
  #requests;
  #accessOf;

  constructor({ orders, floor, requests, accessOf }) {
    this.#orders = orders;
    this.#floor = floor;
    this.#requests = requests;
    this.#accessOf = accessOf;
  }

  #handle(operation, call, { quiet = false } = {}) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      // The board and floor are polled every few seconds: log only changes at INFO.
      if (!quiet) context.log.info({ tenantId: request.actor.tenantId, ...(request.params.id ? { targetId: request.params.id } : {}) }, 'Service request');
      response.json(await call(context, request));
    };
  }

  list = this.#handle('list', async (context, request) => this.#orders.list(context, await this.#accessOf(request), request.query), { quiet: true });
  get = this.#handle('get', (context, request) => this.#orders.get(context, request.params.id), { quiet: true });
  updateStatus = this.#handle('updateStatus', (context, request) => this.#orders.updateStatus(context, request.params.id, request.body));

  floor = this.#handle('floor', (context, request) => this.#floor.floor(context, request.query), { quiet: true });
  table = this.#handle('table', (context, request) => this.#floor.table(context, request.params.id), { quiet: true });
  addOrder = this.#handle('addOrder', async (context, request) => this.#floor.addOrder(context, await this.#accessOf(request), {
    body: request.body ?? {}, key: IdempotencyService.key(request),
  }));
  closeTable = this.#handle('closeTable', async (context, request) => this.#floor.close(context, await this.#accessOf(request), request.params.id, {
    body: request.body ?? {}, key: IdempotencyService.key(request),
  }));

  requests = this.#handle('requests', (context, request) => this.#requests.list(context, request.query), { quiet: true });
  handleRequest = this.#handle('handleRequest', (context, request) => this.#requests.handle(context, request.params.id, request.query));
}
