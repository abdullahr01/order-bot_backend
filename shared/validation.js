import { apiError } from './error-codes.js';
import { MIN_REASON_LENGTH } from './rules/subscriptions.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from paths must be checked first: Postgres rejects a malformed uuid with an error. */
export const isUuid = (value) => typeof value === 'string' && uuid.test(value);

/** First message per field, keyed by dotted path such as options.0.choices.1.price. */
export function fieldErrors(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Returns the parsed value, or throws the contract's 422 with per-field messages. */
export function parseOrThrow(schema, value, { code = 'validation_failed', message = 'Check the highlighted fields.' } = {}) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw apiError(code, message, fieldErrors(parsed.error));
}

/** Every platform-team write carries a reason for the audit log (guide 2.4). */
export function requireReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < MIN_REASON_LENGTH) {
    throw apiError('reason_required', 'Add a short reason. It is saved in the audit log.', { reason: 'Add a short reason.' });
  }
  return text;
}
