import 'dotenv/config';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDevelopmentTarget, databaseConfig } from '../db/config.js';

try {
  assertDevelopmentTarget();
  const apply = process.argv.includes('--apply');
  const { url } = databaseConfig(process.env);
  const parsed = new URL(url);
  parsed.searchParams.set('sslmode', 'verify-full');
  if (process.env.DATABASE_CA_CERT_PATH) parsed.searchParams.set('sslrootcert', process.env.DATABASE_CA_CERT_PATH);
  const secret = decodeURIComponent(parsed.password);
  const redact = (value) => value.replaceAll(secret, '[REDACTED]').replaceAll(parsed.password, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED DATABASE URI]');
  const args = [fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url)),
    'db', 'push', '--skip-vault', '--db-url', parsed.toString(), ...(apply ? ['--yes'] : ['--dry-run'])];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(process.env.DATABASE_CA_CERT_PATH ? { NODE_EXTRA_CA_CERTS: process.env.DATABASE_CA_CERT_PATH } : {}) } });
  // Buffer before redaction so a credential split across chunks cannot leak.
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  console.log(redact(output));
  process.exitCode = code === 0 ? 0 : 1;
} catch {
  console.error('Migration command failed. Check the private migration URI, development target and CLI installation.');
  process.exitCode = 1;
}
