import { readFileSync } from 'node:fs';

export function databaseConfig(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for this database operation.');
  let parsed;
  try {
    parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname ||
        !parsed.username || !parsed.password || parsed.pathname.length < 2 || parsed.hash) throw new Error();
    // Driver URL options cannot silently weaken TLS or change the role/schema.
    for (const name of parsed.searchParams.keys()) {
      if (!['sslmode'].includes(name)) throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a Postgres URI with a database, username and password; only sslmode is allowed as a query option.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const sslMode = env.DATABASE_SSL_MODE || 'verify-full';
  if (!['verify-full', 'disable'].includes(sslMode) || (sslMode === 'disable' && !local)) {
    throw new Error('DATABASE_SSL_MODE must verify TLS for hosted databases; disable is allowed only on loopback.');
  }
  const max = Number(env.DATABASE_POOL_MAX ?? 5);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('DATABASE_POOL_MAX must be between 1 and 20.');
  let ca;
  if (env.DATABASE_CA_CERT_PATH) {
    try { ca = readFileSync(env.DATABASE_CA_CERT_PATH, 'utf8'); }
    catch { throw new Error('DATABASE_CA_CERT_PATH must identify a readable CA certificate.'); }
  }
  parsed.search = ''; // Explicit options below take precedence over URI sslmode.
  return { url: parsed.toString(), options: {
    max, ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    prepare: false, connect_timeout: 10, idle_timeout: 20,
    onnotice: () => {}, debug: false,
    connection: { application_name: 'qr-dinein-backend' },
  } };
}

export function assertDevelopmentTarget(env = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('Development database commands are disabled in production.');
  const { url } = databaseConfig(env);
  let project;
  try { project = new URL(env.SUPABASE_URL).hostname.split('.')[0]; }
  catch { throw new Error('A valid SUPABASE_URL is required to verify the database target.'); }
  const parsed = new URL(url);
  const username = decodeURIComponent(parsed.username);
  const matches = parsed.hostname === `db.${project}.supabase.co` ||
    (parsed.hostname.endsWith('.pooler.supabase.com') && username.endsWith(`.${project}`));
  if (!matches) throw new Error('DATABASE_URL does not match the configured Supabase project.');
}
