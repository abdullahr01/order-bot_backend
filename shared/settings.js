import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }

  return value;
}

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a whole number between 1 and 65535.');
}

const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '');

try {
  new URL(supabaseUrl);
} catch {
  throw new Error('SUPABASE_URL must be a valid URL.');
}

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
  corsOrigins: Object.freeze(
    (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
});
