import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function settings(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { settings } from './shared/settings.js'; console.log(JSON.stringify({ app: settings.app, origins: settings.corsOrigins }));"],
  { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}

test('configuration defaults, origin normalization/deduplication and empty allowlist', () => {
  const defaults = settings({ PORT: undefined, NODE_ENV: undefined, CORS_ORIGINS: '' });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), { app: { name: 'orderbot-backend', environment: 'development', port: 4000 }, origins: [] });
  const normalized = settings({ CORS_ORIGINS: ' HTTP://LOCALHOST:3000/,http://localhost:3000, https://Example.COM:443/ ' });
  assert.equal(normalized.status, 0, normalized.stderr);
  assert.deepEqual(JSON.parse(normalized.stdout).origins, ['http://localhost:3000', 'https://example.com']);
});

for (const port of ['', '0', '65536', '1.5', 'invalid']) {
  test(`configuration rejects invalid port ${JSON.stringify(port)}`, () => {
    const result = settings({ PORT: port });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PORT must be a whole number/);
  });
}
for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY']) {
  test(`configuration requires ${name}`, () => {
    const result = settings({ [name]: '' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Required environment variable ${name} is missing`));
  });
}
for (const [name, value] of [
  ['SUPABASE_URL', 'ftp://private-value-sentinel.invalid'],
  ['SUPABASE_URL', 'https://user:private-value-sentinel@example.invalid'],
  ['CORS_ORIGINS', 'https://example.invalid/private-value-sentinel'],
  ['CORS_ORIGINS', 'https://example.invalid?key=private-value-sentinel'],
  ['CORS_ORIGINS', 'https://example.invalid#private-value-sentinel'],
  ['CORS_ORIGINS', 'https://user:private-value-sentinel@example.invalid'],
  ['CORS_ORIGINS', 'ftp://private-value-sentinel.invalid'],
]) {
  test(`configuration rejects unsafe ${name}: ${new URL(value).protocol} ${value.includes('?') ? 'query' : value.includes('#') ? 'fragment' : value.includes('@') ? 'credentials' : 'origin'}`, () => {
    const result = settings({ [name]: value });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /private-value-sentinel/);
  });
}
