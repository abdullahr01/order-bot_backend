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

export const settings = Object.freeze({
  app: Object.freeze({
    name: 'orderbot-backend',
    environment: process.env.NODE_ENV?.trim() || 'development',
    port,
  }),
  supabase: Object.freeze({
    url: supabaseUrl,
    publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    // The startup schema-root probe requires a server-only secret key.
    secretKey: required('SUPABASE_SECRET_KEY'),
  }),
  corsOrigins: Object.freeze([...new Set(corsOrigins)]),
});
