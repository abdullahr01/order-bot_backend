import { requestContext } from './context.js';

const MODULE = 'TenantController';

/** Platform console: restaurants, their plan, status and fees (guide 9.2, 9.3, 9.5). */
export class TenantController {
  #tenants;
  #subscriptions;
  #entitlements;

  constructor({ tenants, subscriptions, entitlements }) {
    this.#tenants = tenants;
    this.#subscriptions = subscriptions;
    this.#entitlements = entitlements;
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

  recordPayment = async (request, response) => {
    const context = requestContext(request, MODULE, 'recordPayment');
    context.log.info({ tenantId: request.params.id }, 'Recording payment');
    response.json(await this.#subscriptions.recordPayment(context, request.params.id, request.body ?? {}));
  };
}
