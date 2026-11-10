import { requestContext } from './context.js';

/** The restaurant portal's starting point (guide 8.1). */
export class PortalController {
  #portal;
  #accessOf;

  constructor({ portal, accessOf }) {
    this.#portal = portal;
    this.#accessOf = accessOf;
  }

  me = async (request, response) => {
    const context = requestContext(request, 'PortalController', 'me');
    context.log.info({ tenantId: request.actor.tenantId }, 'Loading portal account');
    response.json(await this.#portal.me(context, await this.#accessOf(request)));
  };
}
