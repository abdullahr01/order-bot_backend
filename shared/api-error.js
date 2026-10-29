export class ApiError extends Error {
  constructor(status, code, message, fields) {
    if (
      !Number.isInteger(status) || status < 400 || status > 499 ||
      typeof code !== 'string' || !/^[a-z][a-z0-9_]*$/.test(code) ||
      typeof message !== 'string' || !message.trim() ||
      (fields !== undefined && (
        fields === null || typeof fields !== 'object' || Array.isArray(fields) ||
        !Object.values(fields).every((value) => typeof value === 'string')
      ))
    ) {
      throw new TypeError('ApiError requires a client status, code, safe message and optional field messages.');
    }
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
