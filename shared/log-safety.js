const errorTypes = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError',
  'URIError', 'AggregateError', 'AbortError', 'TimeoutError', 'ApiError',
]);
const errorCodes = new Set([
  'EADDRINUSE', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

// Error messages/stacks can contain credentials, SQL or malformed JSON bodies.
// Keep diagnostic categories; the calling log supplies module/operation context.
export function safeError(error) {
  const details = { type: errorTypes.has(error?.name) ? error.name : 'Error' };
  if (errorCodes.has(error?.code)) details.code = error.code;
  if (errorCodes.has(error?.cause?.code)) details.causeCode = error.cause.code;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    details.status = error.status;
  }
  return details;
}

export function safeRequestPath(url = '') {
  const path = url.split('?')[0];
  if (path === '/health') return path;
  const diner = /^\/public\/tables\/[^/]+(?:\/(orders|requests))?$/.exec(path);
  if (diner) return `/public/tables/:token${diner[1] ? `/${diner[1]}` : ''}`;
  // Unknown paths may themselves contain credentials or personal information.
  const area = /^\/(admin|portal|counter|public)(?:\/|$)/.exec(path);
  return area ? `/${area[1]}/[route]` : '[unmatched]';
}

export function safeRequest(request) {
  return { method: request.method, path: safeRequestPath(request.url) };
}

export function safeResponse(response) {
  return { statusCode: response.statusCode };
}
