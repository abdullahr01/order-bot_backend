import { requestContext } from './context.js';

const MODULE = 'TeamController';

/** The owner's Team screen, PINs and counter PCs (guide 8.8). */
export class TeamController {
  #team;
  #counters;
  #accessOf;

  constructor({ team, counters, accessOf }) {
    this.#team = team;
    this.#counters = counters;
    this.#accessOf = accessOf;
  }

  #handle(operation, call) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      context.log.info({ tenantId: request.actor.tenantId, ...(request.params.id ? { targetId: request.params.id } : {}) }, 'Team request');
      response.json(await call(context, request));
    };
  }

  get = this.#handle('get', async (context, request) => this.#team.team(context, await this.#accessOf(request)));
  add = this.#handle('add', async (context, request) => this.#team.add(context, await this.#accessOf(request), request.body));
  update = this.#handle('update', async (context, request) => this.#team.update(context, await this.#accessOf(request), request.params.id, request.body));
  remove = this.#handle('remove', async (context, request) => this.#team.remove(context, await this.#accessOf(request), request.params.id));
  setPin = this.#handle('setPin', async (context, request) => this.#team.setPin(context, await this.#accessOf(request), request.params.id, request.body));

  listCounters = this.#handle('listCounters', (context) => this.#counters.list(context));
  createPairingCode = this.#handle('createPairingCode', (context, request) => this.#counters.createPairingCode(context, request.body));
  revokeCounter = this.#handle('revokeCounter', (context, request) => this.#counters.revoke(context, request.params.id));
}
