import { OrderModel } from '../model/order.model.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';

/** How many requests already seen to the board keeps showing, so a mistaken tap can be spotted. */
const RECENT = 8;

/** What diners have asked for: the counter's Requests screen (guide 8.4). */
export class ServiceRequestService {
  #database;
  #repository;
  #branches;

  constructor({ database, repository, branches }) {
    this.#database = database;
    this.#repository = repository;
    this.#branches = branches;
  }

  async #branchIds(actor, requested) {
    const all = (await this.#branches.visibleBranches(actor.tenantId, actor.branchId ?? null)).map((branch) => branch.id);
    return !actor.branchId && isUuid(requested) && all.includes(requested) ? [requested] : all;
  }

  async list({ actor, now }, query = {}) {
    const row = await this.#repository.requests(actor.tenantId, await this.#branchIds(actor, query.branch), { recent: RECENT });
    return { open: row.open.map(OrderModel.toRequest), recent: row.recent.map(OrderModel.toRequest), generatedAt: now.toISOString() };
  }

  /** Seen to. Two people may tap at once; the second changes nothing. */
  async handle(context, id, query = {}) {
    const { actor, log, now } = context;
    const branchIds = await this.#branchIds(actor);
    const found = isUuid(id) && await this.#database.withTx(
      (tx) => this.#repository.handleRequest(tx, actor.tenantId, branchIds, id, { by: actor.name, now }), { logger: log },
    );
    if (!found) throw apiError('not_found', 'That request could not be found.');
    log.success({ tenantId: actor.tenantId, requestId: id }, 'Request seen to');
    return this.list(context, query);
  }
}
