import { createClient } from '@supabase/supabase-js';
import { settings } from '../shared/settings.js';

// The publishable key keeps Row Level Security in effect. Use a separate,
// explicitly named admin client only for trusted server-side admin tasks.
export const supabase = createClient(
  settings.supabase.url,
  settings.supabase.publishableKey,
  {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  },
);

export function createUserSupabaseClient(accessToken) {
  if (!accessToken) {
    throw new Error('A signed-in user access token is required.');
  }

  return createClient(
    settings.supabase.url,
    settings.supabase.publishableKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    },
  );
}

export async function checkSupabaseConnection() {
  const response = await fetch(`${settings.supabase.url}/rest/v1/`, {
    method: 'GET',
    headers: {
      // Supabase requires a secret key to return the REST schema root.
      // This key is used only for the probe and never for application queries.
      apikey: settings.supabase.secretKey,
      Accept: 'application/openapi+json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Supabase Data API health check failed (HTTP ${response.status}).`);
  }

  return true;
}
