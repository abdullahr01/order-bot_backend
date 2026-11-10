import { requestContext } from './context.js';

const MODULE = 'MenuController';

/** Menu, stations and dish photos (guide 8.6). */
export class MenuController {
  #menu;
  #photos;
  #accessOf;

  constructor({ menu, photos, accessOf }) {
    this.#menu = menu;
    this.#photos = photos;
    this.#accessOf = accessOf;
  }

  /** Each handler: context, access (loaded once per request), one service call. */
  #handle(operation, call) {
    return async (request, response) => {
      const context = requestContext(request, MODULE, operation);
      context.log.info({ tenantId: request.actor.tenantId, ...(request.params.id ? { targetId: request.params.id } : {}) }, 'Menu request');
      response.json(await call(context, await this.#accessOf(request), request));
    };
  }

  get = this.#handle('get', (context, access) => this.#menu.menu(context.actor.tenantId, access));
  createCategory = this.#handle('createCategory', (context, access, request) => this.#menu.createCategory(context, access, request.body));
  updateCategory = this.#handle('updateCategory', (context, access, request) => this.#menu.updateCategory(context, access, request.params.id, request.body));
  deleteCategory = this.#handle('deleteCategory', (context, access, request) => this.#menu.deleteCategory(context, access, request.params.id));
  reorderCategories = this.#handle('reorderCategories', (context, access, request) => this.#menu.reorderCategories(context, access, request.body));
  reorderItems = this.#handle('reorderItems', (context, access, request) => this.#menu.reorderItems(context, access, request.params.id, request.body));
  createStation = this.#handle('createStation', (context, access, request) => this.#menu.createStation(context, access, request.body));
  renameStation = this.#handle('renameStation', (context, access, request) => this.#menu.renameStation(context, access, request.params.id, request.body));
  deleteStation = this.#handle('deleteStation', (context, access, request) => this.#menu.deleteStation(context, access, request.params.id));
  createItem = this.#handle('createItem', (context, access, request) => this.#menu.createItem(context, access, request.body));
  updateItem = this.#handle('updateItem', (context, access, request) => this.#menu.updateItem(context, access, request.params.id, request.body));
  deleteItem = this.#handle('deleteItem', (context, access, request) => this.#menu.deleteItem(context, access, request.params.id));

  uploadPhoto = async (request, response) => {
    const context = requestContext(request, MODULE, 'uploadPhoto');
    context.log.info({ tenantId: request.actor.tenantId }, 'Dish photo received');
    response.json(await this.#photos.upload(context, request.body));
  };
}
