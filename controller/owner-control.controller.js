import { requestContext } from './context.js';

const MODULE = 'OwnerControlController';

/** The owner's figures and "ask us" requests (guide 8.1, 8.9). */
export class OwnerControlController {
  #owner;
  #console;
  #accessOf;

  constructor({ owner, console: consoleService, accessOf }) {
    this.#owner = owner;
    this.#console = consoleService;
    this.#accessOf = accessOf;
  }

  #handle(operation, call, { quiet = true } = {}) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      if (!quiet) context.log.info({ tenantId: request.actor.tenantId }, 'Owner change');
      response.json(await call(context, await this.#accessOf(request), request));
    };
  }

  dashboard = this.#handle('dashboard', (context, access, request) => this.#owner.dashboard(context, access, request.query));
  billing = this.#handle('billing', (context, access) => this.#owner.billing(context, access));
  ask = this.#handle('ask', (context, access, request) => this.#console.ask(context, access, request.body ?? {}), { quiet: false });
  voidLog = this.#handle('voidLog', (context, access, request) => this.#owner.voidLog(context, access, request.query));
  cashClose = this.#handle('cashClose', (context, access, request) => this.#owner.cashClose(context, access, request.query));
  saveCashClose = this.#handle('saveCashClose', (context, access, request) => this.#owner.saveCashClose(context, access, request.body ?? {}), { quiet: false });
  dailySummary = this.#handle('dailySummary', (context, access, request) => this.#owner.dailySummary(context, access, request.query));
  branches = this.#handle('branches', (context, access) => this.#owner.branchesOverview(context, access));
  report = this.#handle('report', (context, access, request) => this.#owner.report(context, access, request.query));
}
