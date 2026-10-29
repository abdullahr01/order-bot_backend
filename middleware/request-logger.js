import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { safeError, safeRequest, safeRequestPath, safeResponse } from '../shared/log-safety.js';

export function createRequestLogger(logger) {
  const httpLogger = pinoHttp({
    logger,
    wrapSerializers: false,
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    genReqId(_request, response) {
      const id = randomUUID();
      response.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: { req: safeRequest, res: safeResponse, err: safeError },
    customProps: () => ({ module: 'HTTP', operation: 'complete' }),
    customLogLevel(_request, response, error) {
      return error || !response.writableFinished || response.statusCode >= 400 ? 'error' : 'success';
    },
    customSuccessMessage(_request, response) {
      return !response.writableFinished ? 'Request aborted' :
        response.statusCode >= 400 ? 'Request rejected' : 'Request completed';
    },
    customErrorMessage: () => 'Request failed',
    customErrorObject(_request, response, _error, record) {
      // ErrorHandler emits the diagnostic once; completion carries the outcome.
      return { res: response, durationMs: record.durationMs };
    },
  });

  return (request, response, next) => {
    httpLogger(request, response);
    request.log = request.log.child({ module: 'HTTP' });
    request.log.info({
      operation: 'receive', method: request.method, path: safeRequestPath(request.url),
    }, 'Request received');
    next();
  };
}
