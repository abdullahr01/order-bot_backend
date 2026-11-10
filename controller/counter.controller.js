import { requestContext } from './context.js';

const MODULE = 'CounterController';

/** The counter PC's own routes (guide 7.2). Its other work goes through /portal. */
export class CounterController {
  #counters;

  constructor({ counters }) { this.#counters = counters; }

  pair = async (request, response) => {
    const context = requestContext(request, MODULE, 'pair');
    context.log.info('Pairing a counter');
    response.json(await this.#counters.pair(context, request.body));
  };

  session = async (request, response) => {
    const context = requestContext(request, MODULE, 'session');
    response.json(await this.#counters.session(context.actor));
  };

  unlock = async (request, response) => {
    const context = requestContext(request, MODULE, 'unlock');
    context.log.info({ tenantId: request.actor.tenantId, deviceId: request.actor.deviceId }, 'Unlocking the counter');
    response.json(await this.#counters.unlock(context, request.body));
  };

  lock = async (request, response) => {
    const context = requestContext(request, MODULE, 'lock');
    response.json(await this.#counters.lock(context));
  };
}
