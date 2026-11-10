import { requestContext } from './context.js';

const MODULE = 'ServiceSettingsController';

/** Opening hours, pauses and the branch's day (guide 8.7). */
export class ServiceSettingsController {
  #settings;

  constructor({ settings }) { this.#settings = settings; }

  get = async (request, response) => {
    response.json(await this.#settings.settings(request.actor.tenantId));
  };

  update = async (request, response) => {
    const context = requestContext(request, MODULE, 'update');
    context.log.info({ tenantId: request.actor.tenantId }, 'Saving opening hours or pause');
    response.json(await this.#settings.update(context, request.body));
  };

  today = async (request, response) => {
    response.json(await this.#settings.today(requestContext(request, MODULE, 'today')));
  };

  pauseBranch = async (request, response) => {
    const context = requestContext(request, MODULE, 'pauseBranch');
    context.log.info({ tenantId: request.actor.tenantId }, 'Pausing or resuming the branch');
    response.json(await this.#settings.pauseBranch(context, request.body));
  };
}
