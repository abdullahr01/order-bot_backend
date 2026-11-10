import express from 'express';
import { apiError } from '../shared/error-codes.js';

// A photo is about 8 MB at most, which is roughly 11 MB as base64 text.
const PHOTO_BODY_LIMIT = '12mb';

/** Parses the photo upload only after sign-in and permission checks, with its own limit. */
function photoBody() {
  const parse = express.json({ limit: PHOTO_BODY_LIMIT });
  return (request, response, next) => parse(request, response, (error) => {
    if (error?.type === 'entity.too.large') return next(apiError('photo_too_large', 'That photo is too large. Try a smaller one.'));
    return next(error);
  });
}

/**
 * /portal/menu (guide 8.6). Owners edit; staff and counters may only mark dishes sold
 * out. Setup changes are refused from day 30 of non-payment, and everything once the
 * account is suspended.
 */
export class MenuRouter {
  #controller;
  #access;

  constructor({ controller, access }) {
    this.#controller = controller;
    this.#access = access;
  }

  build() {
    const router = express.Router();
    const c = this.#controller;
    const { requirePermission, requireSetupWritable, requireWritable } = this.#access;
    const edit = [requirePermission('menu.edit'), requireSetupWritable];

    router.get('/menu', c.get);
    router.post('/menu/categories', ...edit, c.createCategory);
    router.put('/menu/categories/order', ...edit, c.reorderCategories);
    router.patch('/menu/categories/:id', ...edit, c.updateCategory);
    router.delete('/menu/categories/:id', ...edit, c.deleteCategory);
    router.put('/menu/categories/:id/order', ...edit, c.reorderItems);
    router.post('/menu/stations', ...edit, c.createStation);
    router.patch('/menu/stations/:id', ...edit, c.renameStation);
    router.delete('/menu/stations/:id', ...edit, c.deleteStation);
    router.post('/menu/items', ...edit, c.createItem);
    // Staff may send only the sold-out fields; the service checks the rest.
    router.patch('/menu/items/:id', requirePermission('menu.availability'), requireWritable, c.updateItem);
    router.delete('/menu/items/:id', ...edit, c.deleteItem);
    router.post('/menu/photos', ...edit, photoBody(), c.uploadPhoto);
    return router;
  }
}
