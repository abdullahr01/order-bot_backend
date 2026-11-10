import { SERVICE_REQUEST_KINDS } from '../shared/rules/constants.js';
import { requestContext } from './context.js';

const MODULE = 'DinerController';

/** The page behind a table's QR code (guide 7.1). The token is never logged. */
export class DinerController {
  #diner;

  constructor({ diner }) { this.#diner = diner; }

  page = async (request, response) => {
    response.json(await this.#diner.page(request.params.token, new Date()));
  };

  order = async (request, response) => {
    const context = requestContext(request, MODULE, 'order');
    context.log.info('Diner order received');
    response.json(await this.#diner.order(context, request.params.token, request.body ?? {}));
  };

  request = async (request, response) => {
    const context = requestContext(request, MODULE, 'request');
    // Only a known kind is logged: the body comes from anyone with the QR code.
    context.log.info({ kind: SERVICE_REQUEST_KINDS.includes(request.body?.kind) ? request.body.kind : 'unknown' }, 'Diner request received');
    response.json(await this.#diner.request(context, request.params.token, request.body ?? {}));
  };
}
