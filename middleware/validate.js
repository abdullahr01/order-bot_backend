import { parseOrThrow } from '../shared/validation.js';

/** Replaces the body with the parsed, trimmed value, or answers 422 with per-field messages. */
export function validateBody(schema, options) {
  return (request, _response, next) => {
    request.body = parseOrThrow(schema, request.body ?? {}, options);
    next();
  };
}
