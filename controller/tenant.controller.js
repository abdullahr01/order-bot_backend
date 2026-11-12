import { requestContext } from './context.js';

const MODULE = 'TenantController';

/** Platform console: restaurants, their plan, status and fees (guide 9.2, 9.3, 9.5). */
export class TenantController {
  #tenants;
  #subscriptions;
  #entitlements;
  #branches;

  constructor({ tenants, subscriptions, entitlements, branches }) {
    this.#tenants = tenants;
    this.#subscriptions = subscriptions;
    this.#entitlements = entitlements;
    this.#branches = branches;
  }

  list = async (request, response) => {
    const context = requestContext(request, MODULE, 'list');
    context.log.info('Listing restaurants');
    response.json(await this.#tenants.list(context, request.query));
  };

  create = async (request, response) => {
    const context = requestContext(request, MODULE, 'create');
    context.log.info('Signing up a restaurant');
    response.status(201).json(await this.#tenants.create(context, request.body ?? {}));
  };

  detail = async (request, response) => {
    const context = requestContext(request, MODULE, 'detail');
    context.log.info({ tenantId: request.params.id }, 'Loading restaurant');
    response.json(await this.#tenants.detail(request.params.id, context.now));
  };

  update = async (request, response) => {
    const context = requestContext(request, MODULE, 'update');
    context.log.info({ tenantId: request.params.id }, 'Editing restaurant details');
    response.json(await this.#tenants.update(context, request.params.id, request.body ?? {}));
  };

  setOnboardingStep = async (request, response) => {
    const context = requestContext(request, MODULE, 'setOnboardingStep');
    context.log.info({ tenantId: request.params.id }, 'Saving checklist step');
    response.json(await this.#tenants.setOnboardingStep(context, request.params.id, request.body, this.#entitlements));
  };

  changePlan = async (request, response) => {
    const context = requestContext(request, MODULE, 'changePlan');
    context.log.info({ tenantId: request.params.id }, 'Changing plan');
    response.json(await this.#subscriptions.changePlan(context, request.params.id, request.body ?? {}));
  };

  cancelScheduledChange = async (request, response) => {
    const context = requestContext(request, MODULE, 'cancelScheduledChange');
    context.log.info({ tenantId: request.params.id }, 'Cancelling scheduled plan change');
    response.json(await this.#subscriptions.cancelScheduledChange(context, request.params.id, request.body ?? {}));
  };

  setStatus = async (request, response) => {
    const context = requestContext(request, MODULE, 'setStatus');
    context.log.info({ tenantId: request.params.id }, 'Changing status');
    response.json(await this.#subscriptions.setStatus(context, request.params.id, request.body ?? {}));
  };

  #write(operation, call) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      context.log.info({ tenantId: request.params.id }, 'Console change');
      response.json(await call(context, request));
    };
  }

  addAddon = this.#write('addAddon', (context, request) => this.#subscriptions.addAddon(context, request.params.id, request.body ?? {}));
  setAddonQuantity = this.#write('setAddonQuantity', (context, request) => this.#subscriptions.setAddonQuantity(context, request.params.id, request.params.addonId, request.body ?? {}));
  removeAddon = this.#write('removeAddon', (context, request) => this.#subscriptions.removeAddon(context, request.params.id, request.params.addonId, request.body ?? {}));
  createOverride = this.#write('createOverride', (context, request) => this.#subscriptions.createOverride(context, request.params.id, request.body ?? {}));
  removeOverride = this.#write('removeOverride', (context, request) => this.#subscriptions.removeOverride(context, request.params.id, request.params.overrideId, request.body ?? {}));
  addBranch = this.#write('addBranch', (context, request) => this.#branches.add(context, request.params.id, request.body));
  updateBranch = this.#write('updateBranch', (context, request) => this.#branches.update(context, request.params.id, request.params.branchId, request.body));
  removeBranch = this.#write('removeBranch', (context, request) => this.#branches.remove(context, request.params.id, request.params.branchId, request.body ?? {}));

  recordPayment = async (request, response) => {
    const context = requestContext(request, MODULE, 'recordPayment');
    context.log.info({ tenantId: request.params.id }, 'Recording payment');
    response.json(await this.#subscriptions.recordPayment(context, request.params.id, request.body ?? {}));
  };
}
