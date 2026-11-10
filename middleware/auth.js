// Identifies the caller and sets request.actor before any handler runs.
export function createAuthMiddleware(authService) {
  const guard = (method, operation) => async (request, _response, next) => {
    const log = request.log.child({ module: 'Auth', operation });
    log.info('Checking caller credentials');
    request.actor = await authService[method](request.headers, log);
    next();
  };

  return {
    requireAdmin: guard('authenticateAdmin', 'admin'),
    requirePortal: guard('authenticatePortal', 'portal'),
    requireDevice: guard('authenticateDevice', 'device'),
  };
}
