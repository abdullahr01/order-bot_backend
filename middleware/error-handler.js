import { ApiError } from '../shared/api-error.js';

const parserErrors = new Map([
  ['entity.parse.failed', [400, 'The request body must contain valid JSON.']],
  ['entity.too.large', [413, 'The request is too large.']],
  ['charset.unsupported', [415, 'The request uses an unsupported character encoding.']],
  ['encoding.unsupported', [415, 'The request uses an unsupported content encoding.']],
  ['request.aborted', [400, 'The request was interrupted.']],
  ['request.size.invalid', [400, 'The request body has an invalid length.']],
]);

export function notFound(_request, _response, next) {
  next(new ApiError(404, 'not_found', 'The requested resource was not found.'));
}

export function errorHandler(error, request, response, next) {
  if (response.headersSent) return next(error);
  let status = 500;
  let body = { code: 'server_error', message: 'Something went wrong. Please try again.' };
  if (error instanceof ApiError) {
    status = error.status;
    body = { code: error.code, message: error.message };
    if (error.fields !== undefined) body.fields = error.fields;
  } else if (parserErrors.has(error?.type)) {
    const [parserStatus, message] = parserErrors.get(error.type);
    status = parserStatus;
    body = { code: 'bad_request', message };
  }
  request.log.error({
    module: 'ErrorHandler', operation: 'respond', statusCode: status, code: body.code, err: error,
  }, status >= 500 ? 'Unexpected request failure' : 'Request could not be processed');
  response.status(status).json(body);
}
