import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, assertDevelopmentTarget } from '../db/config.js';
import { captureLogger } from './helpers.js';

const uri = 'postgresql://postgres:secret-sentinel@db.example.invalid:5432/postgres';

test('SQL configuration requires credentials, validates pool limits and never prints connection input', () => {
  for (const value of ['', 'https://secret-sentinel.invalid', 'postgresql://user@db.invalid/db', 'bad-secret-sentinel', `${uri}?options=unsafe`]) {
    assert.throws(() => databaseConfig({ DATABASE_URL: value }), (error) => !error.message.includes('secret-sentinel'));
  }
  for (const value of ['0', '21', 'NaN', '1.5']) assert.throws(() => databaseConfig({ DATABASE_URL: uri, DATABASE_POOL_MAX: value }));
  const config = databaseConfig({ DATABASE_URL: uri });
  assert.equal(config.options.max, 5);
  assert.equal(config.options.ssl.rejectUnauthorized, true);
  assert.equal(config.options.debug, false);
});

test('hosted TLS cannot be disabled through config or URI query parameters', () => {
  assert.throws(() => databaseConfig({ DATABASE_URL: uri, DATABASE_SSL_MODE: 'disable' }));
  assert.throws(() => databaseConfig({ DATABASE_URL: uri, DATABASE_SSL_MODE: 'prefer' }));
  const config = databaseConfig({ DATABASE_URL: `${uri}?sslmode=disable` });
  assert.equal(config.options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(config.url).search, '');
  assert.equal(databaseConfig({ DATABASE_URL: 'postgres://user:pass@127.0.0.1/db', DATABASE_SSL_MODE: 'disable' }).options.ssl, false);
});

test('development commands reject production and a mismatched Supabase database', () => {
  const env = { SUPABASE_URL: 'https://projectref.supabase.co', DATABASE_URL: 'postgresql://postgres:pass@db.projectref.supabase.co/postgres' };
  assert.doesNotThrow(() => assertDevelopmentTarget(env));
  assert.doesNotThrow(() => assertDevelopmentTarget({ ...env, DATABASE_URL: 'postgresql://postgres.projectref:pass@aws-0-region.pooler.supabase.com/postgres' }));
  assert.throws(() => assertDevelopmentTarget({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => assertDevelopmentTarget({ ...env, DATABASE_URL: 'postgresql://postgres:pass@db.another.supabase.co/postgres' }));
});

test('SQL error diagnostics retain safe codes while omitting statement, parameters and connection strings', () => {
  const capture = captureLogger();
  const error = Object.assign(new Error('SQL-secret-sentinel'), {
    code: '23505', query: 'SQL-secret-sentinel', parameters: ['SQL-secret-sentinel'], detail: 'SQL-secret-sentinel',
  });
  capture.logger.error({ err: error, connectionString: uri, config: { databaseUrl: uri } }, 'Transaction rejected');
  assert.doesNotMatch(capture.text(), /SQL-secret-sentinel|secret-sentinel/);
  assert.equal(capture.records()[0].err.code, '23505');
});
