/**
 * What a service needs from the request: who is asking (from the verified credentials,
 * never the body), a logger carrying the request ID, and one clock for the whole request.
 */
export function requestContext(request, module, operation) {
  return Object.freeze({
    actor: request.actor,
    log: request.log.child({ module, operation }),
    now: new Date(),
  });
}
