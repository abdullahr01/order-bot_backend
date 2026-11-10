import { MenuModel } from '../model/menu.model.js';
import { OrderModel } from '../model/order.model.js';
import { itemAvailability, scheduleOpen, scheduleText } from '../shared/rules/menu.js';
import { resolveChoices } from '../shared/rules/orders.js';
import { apiError } from '../shared/error-codes.js';
import { isUuid } from '../shared/validation.js';

const refuse = (message) => apiError('validation_failed', message, { items: message });

/**
 * Checks and prices order lines from the database, for diners and staff alike (guide
 * 7.1, 8.3, 11.4). Never trusts a price or a name from the phone: each line is the
 * dish's price plus the chosen options' prices, as saved now.
 */
export async function priceLines(menu, tx, { tenantId, lines, features, now, timeZone }) {
  if (!Array.isArray(lines) || lines.length === 0) throw refuse('Add at least one dish.');
  if (lines.length > OrderModel.MAX_LINES) throw refuse('That’s a very long order. Please send it in two parts.');
  const ids = lines.map((line) => line?.menuItemId);
  if (!ids.every(isUuid)) throw refuse('A dish is no longer on the menu.');
  const dishes = new Map((await menu.dishesForOrder(tx, tenantId, [...new Set(ids)])).map((row) => [row.id, row]));
  const timeMenus = features.has('time_menus');
  const routing = features.has('station_routing');

  const items = lines.map((line) => {
    const row = dishes.get(line.menuItemId);
    if (!row) throw refuse('A dish is no longer on the menu.');
    const dish = MenuModel.toItem(row);
    const quantity = Number(line.quantity);
    if (itemAvailability(dish, now) !== 'available') throw refuse(`${dish.name} is not available right now.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > OrderModel.MAX_QUANTITY) {
      throw apiError('validation_failed', 'Check the quantities.', { items: `Quantities from 1 to ${OrderModel.MAX_QUANTITY}.` });
    }
    // Without time-based menus on the plan, schedules are ignored.
    if (timeMenus && row.category_schedule && !scheduleOpen(row.category_schedule, now, timeZone)) {
      throw refuse(`${dish.name} is on the ${row.category_name} menu: ${scheduleText(row.category_schedule)}.`);
    }
    const choices = Array.isArray(line.choices) ? line.choices.map(String) : [];
    const resolved = resolveChoices(dish, choices);
    if (!resolved.ok) throw refuse(resolved.error);
    return {
      name: dish.name,
      quantity,
      unitPrice: dish.price + resolved.extra,
      ...(resolved.labels.length ? { options: resolved.labels } : {}),
      // Where its kitchen slip prints, as routed now; orders keep it if the menu changes.
      ...(routing && row.category_station_id ? { stationId: row.category_station_id } : {}),
    };
  });
  return { items, total: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) };
}
