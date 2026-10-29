import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLogger } from './helpers.js';

for (const colorize of [false, true]) {
  test(`development labels, context and ${colorize ? 'requested ANSI colors' : 'plain fallback'}`, () => {
    const capture = captureLogger({ environment: 'development', colorize });
    const logger = capture.logger.child({ module: 'Example', operation: 'verify', requestId: 'test-id' });
    logger.info('Progress');
    logger.success('Complete');
    logger.error({ err: new Error('hidden-error-sentinel') }, 'Failed');
    const output = capture.text();
    for (const label of ['[INFO]', '[SUCCESS]', '[ERR]', '[Example.verify]', '[req:test-id]']) assert.ok(output.includes(label), label);
    assert.doesNotMatch(output, /hidden-error-sentinel/);
    if (colorize) {
      assert.ok(output.includes('\u001b[37m[INFO]'));
      assert.ok(output.includes('\u001b[92m[SUCCESS]'));
      assert.ok(output.includes('\u001b[91m[ERR]'));
    } else assert.doesNotMatch(output, /\u001b\[/);
  });
}

test('production logs stay structured, preserve diagnostic categories and redact safe context', () => {
  const capture = captureLogger({ environment: 'production', colorize: true });
  const error = new TypeError('private-error-sentinel', { cause: { code: 'ENOTFOUND', message: 'private-cause-sentinel' } });
  error.body = 'private-body-sentinel';
  capture.logger.error({
    err: error, module: 'Server', operation: 'start',
    authorization: 'private-auth-sentinel', context: { pin: 'private-pin-sentinel', email: 'private-email-sentinel' },
    body: { secret: 'private-body-sentinel' }, token: 'private-token-sentinel',
  }, 'Startup failed');
  capture.logger.success('Ready');
  assert.doesNotMatch(capture.text(), /private-.*?-sentinel|\u001b\[/);
  const records = capture.records();
  assert.deepEqual(records[0].err, { type: 'TypeError', causeCode: 'ENOTFOUND' });
  assert.equal(records[0].levelLabel, 'ERR');
  assert.equal(records[1].level, 35);
  assert.equal(records[1].levelLabel, 'SUCCESS');
});
