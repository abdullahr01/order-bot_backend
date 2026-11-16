import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }

  return value;
}

const port = Number(process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a whole number between 1 and 65535.');
}

const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);

if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
  throw new Error('TRUST_PROXY_HOPS must be a whole number between 0 and 5.');
}

const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '');

try {
  const parsedUrl = new URL(supabaseUrl);

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Invalid Supabase URL');
  }
} catch {
  throw new Error('SUPABASE_URL must be an HTTP or HTTPS URL without embedded credentials.');
}

const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => {
    try {
      const url = new URL(origin);

      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash
      ) {
        throw new Error('Invalid CORS origin');
      }

      return url.origin;
    } catch {
      throw new Error('CORS_ORIGINS must contain comma-separated HTTP or HTTPS origins without paths, queries, fragments or credentials.');
    }
  });

// Where an owner's invite email sends them to set their password: the portal.
// Supabase only follows it if it is in the project's Redirect URLs list.
const portalUrl = (process.env.PORTAL_URL?.trim() || 'http://localhost:3002').replace(/\/$/, '');

try {
  const parsedUrl = new URL(portalUrl);

  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('Invalid portal URL');
  }
} catch {
  throw new Error('PORTAL_URL must be an HTTP or HTTPS URL without credentials, query or fragment.');
}

const environment = process.env.NODE_ENV?.trim() || 'development';

// Our own emails (the unpaid reminders). Supabase's SMTP setting only sends its sign-in
// emails. All of these or none: without SMTP_HOST the jobs log "email skipped".
let mail = null;
const smtpHost = process.env.SMTP_HOST?.trim();
if (smtpHost) {
  const smtpPort = Number(process.env.SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error('SMTP_PORT must be a whole number between 1 and 65535.');
  }
  const from = required('MAIL_FROM');
  if (!/^[^<>\r\n]*<?[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>?$/.test(from)) {
    throw new Error('MAIL_FROM must be an email address, optionally with a name: QR Dine-in <name@example.com>.');
  }
  mail = Object.freeze({ host: smtpHost, port: smtpPort, user: required('SMTP_USER'), password: required('SMTP_PASSWORD'), from });
}

// The daily jobs (9 am Pakistan and UK time). On by default only in production, so a
// developer's `npm run dev` never suspends or emails anyone by surprise.
const jobsSetting = process.env.JOBS_ENABLED?.trim().toLowerCase();
if (jobsSetting && !['true', 'false'].includes(jobsSetting)) throw new Error('JOBS_ENABLED must be true or false.');
const jobsEnabled = jobsSetting ? jobsSetting === 'true' : environment === 'production';

export const settings = Object.freeze({
  app: Object.freeze({
    name: 'orderbot-backend',
    environment,
    port,
    trustProxyHops,
  }),
  mail,
  jobsEnabled,
  supabase: Object.freeze({
    url: supabaseUrl,
    // Server only: Auth admin and Storage.
    secretKey: required('SUPABASE_SECRET_KEY'),
  }),
  corsOrigins: Object.freeze([...new Set(corsOrigins)]),
  portalUrl,
});
