import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ApiError } from '../shared/api-error.js';
import { hashPin, hashToken, newPairingCode, newTableToken, randomToken, verifyPin } from '../shared/crypto.js';
import { apiError, ERROR_STATUS } from '../shared/error-codes.js';
import { pageWindow, paginated } from '../shared/pagination.js';
import { formatMoney } from '../shared/rules/format.js';
import { isUuid, parseOrThrow, requireReason } from '../shared/validation.js';

test('every error code carries the status the guide gives it', () => {
  for (const [code, status] of [
    ['bad_request', 400], ['account_removed', 401], ['counter_locked', 401], ['device_revoked', 401], ['forbidden', 403], ['feature_locked', 403],
    ['limit_reached', 403], ['account_paused', 403], ['tenant_not_found', 404], ['override_not_found', 404], ['order_changed', 409], ['no_session', 409],
    ['menu_changed', 409], ['already_paid', 409], ['branch_limit', 409], ['photo_too_large', 413], ['validation_failed', 422], ['invalid_transition', 422],
    ['wrong_pin', 422], ['reason_required', 422], ['invalid_photo', 422], ['pin_held', 429], ['too_many_orders', 429], ['rate_limited', 429],
  ]) assert.equal(ERROR_STATUS[code], status, code);
  const error = apiError('wrong_pin', 'Wrong PIN. 3 tries left.');
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.throws(() => apiError('made_up', 'No.'), TypeError);
});

test('validation answers 422 with dotted field paths', () => {
  const schema = z.object({ options: z.array(z.object({ price: z.number({ message: 'Enter a price' }) })) });
  assert.deepEqual(parseOrThrow(schema, { options: [{ price: 5 }] }), { options: [{ price: 5 }] });
  assert.throws(() => parseOrThrow(schema, { options: [{ price: 'x' }] }), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'validation_failed');
    assert.deepEqual(error.fields, { 'options.0.price': 'Enter a price' });
    return true;
  });
  assert.throws(() => parseOrThrow(schema, {}, { code: 'invalid_input', message: 'Some details need fixing.' }), (error) => error.code === 'invalid_input');
});

test('platform-team writes need a real reason', () => {
  assert.equal(requireReason('  Agreed on call  '), 'Agreed on call');
  for (const reason of [undefined, null, 5, '', 'abcd']) {
    assert.throws(() => requireReason(reason), (error) => error.code === 'reason_required');
  }
});

test('ids are checked before reaching the database', () => {
  assert.ok(isUuid('11111111-1111-4111-8111-111111111111'));
  for (const value of ['t_01', '', null, undefined, "1' or '1'='1"]) assert.ok(!isUuid(value));
});

test('pagination clamps bad and out-of-range pages', () => {
  assert.deepEqual(pageWindow(95, {}), { page: 1, pageSize: 25, pageCount: 4, offset: 0 });
  assert.deepEqual(pageWindow(95, { page: '2', pageSize: '10' }), { page: 2, pageSize: 10, pageCount: 10, offset: 10 });
  assert.deepEqual(pageWindow(95, { page: '99' }, { defaultSize: 50 }), { page: 2, pageSize: 50, pageCount: 2, offset: 50 });
  assert.equal(pageWindow(5, { pageSize: '5000' }, { maxSize: 100 }).pageSize, 100);
  assert.equal(pageWindow(0, { page: 'x', pageSize: '-1' }).pageCount, 1);
  assert.deepEqual(paginated(['a'], 1, pageWindow(1, {})), { items: ['a'], total: 1, page: 1, pageSize: 25, pageCount: 1 });
});

test('tokens and PINs are never stored as given', async () => {
  const token = randomToken();
  assert.equal(token.length, 64);
  assert.match(hashToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashToken(token), token);
  assert.match(newTableToken(), /^[a-hjkmnp-z2-9]{20}$/);
  assert.match(newPairingCode(), /^\d{6}$/);
  const hash = await hashPin('1234');
  assert.match(hash, /^\$argon2id\$/);
  assert.ok(await verifyPin(hash, '1234'));
  assert.ok(!await verifyPin(hash, '4321'));
});

test('money shows in the restaurant’s own currency', () => {
  assert.equal(formatMoney(15000, 'PKR'), 'PKR 15,000');
  assert.equal(formatMoney(149, 'GBP'), '£149');
});
