import express from 'express';

// The route guard (guide 3.4): every area's check runs before any of its handlers.
// Entity routers are added under `routers` as each stage builds them.
export function createApiRouter({ auth, limits, routers = {} }) {
  const api = express.Router();

  const area = (path, guards, inner) => {
    const router = express.Router();
    router.use(...guards);
    if (inner) router.use(inner);
    api.use(path, router);
  };

  area('/admin', [auth.requireAdmin], routers.admin);
  area('/portal', [auth.requirePortal], routers.portal);

  const counterGuards = [
    (request, response, next) => (request.path === '/pair' && request.method === 'POST' ? limits.pairing(request, response, next) : next()),
    (request, response, next) => (request.path === '/pair' ? next() : auth.requireDevice(request, response, next)),
  ];
  area('/counter', counterGuards, routers.counter);

  const diners = express.Router();
  diners.get('/tables/:token', limits.dinerReads);
  if (routers.public) diners.use(routers.public);
  api.use('/public', diners);

  return api;
}
