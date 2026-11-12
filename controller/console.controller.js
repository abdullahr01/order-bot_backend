import { requestContext } from './context.js';

const MODULE = 'ConsoleController';

/** The platform console's overview, price lists and partners (guide 9.1, 9.6-9.9). */
export class ConsoleController {
  #console;
  #catalog;
  #partners;

  constructor({ console: consoleService, catalog, partners }) {
    this.#console = consoleService;
    this.#catalog = catalog;
    this.#partners = partners;
  }

  #handle(operation, call, { quiet = true } = {}) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      if (!quiet) context.log.info({ ...(request.params.id ? { targetId: request.params.id } : {}) }, 'Console change');
      response.json(await call(context, request));
    };
  }

  dashboard = this.#handle('dashboard', (context) => this.#console.dashboard(context));
  events = this.#handle('events', (context, request) => this.#console.events(context, request.query));
  requests = this.#handle('requests', (context, request) => this.#console.requests(context, request.query));
  handleRequest = this.#handle('handleRequest', (context, request) => this.#console.handleRequest(context, request.params.id, request.body ?? {}), { quiet: false });
  audit = this.#handle('audit', (context) => this.#console.audit(context));
  updateAudit = this.#handle('updateAudit', (context, request) => this.#console.updateAudit(context, request.params.month, request.body ?? {}), { quiet: false });

  catalog = this.#handle('catalog', (context) => this.#catalog.get(context));
  updatePlan = this.#handle('updatePlan', (context, request) => this.#catalog.updatePlan(context, request.params.planId, request.body ?? {}), { quiet: false });
  updateAddon = this.#handle('updateAddon', (context, request) => this.#catalog.updateAddon(context, request.params.addonId, request.body ?? {}), { quiet: false });

  partners = this.#handle('partners', (context) => this.#partners.list(context));
  partner = this.#handle('partner', (context, request) => this.#partners.detail(context, request.params.id));
  updatePartner = this.#handle('updatePartner', (context, request) => this.#partners.update(context, request.params.id, request.body ?? {}), { quiet: false });
  recordPartnerPayment = this.#handle('recordPartnerPayment', (context, request) => this.#partners.recordPayment(context, request.params.id, request.params.month, request.body ?? {}), { quiet: false });
}
