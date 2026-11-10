import { createClient } from '@supabase/supabase-js';
import { settings } from '../shared/settings.js';

/** Server-only client for Auth admin (invites, users) and Storage (photos). Never used for business data. */
export function createSupabaseAdmin() {
  return createClient(settings.supabase.url, settings.supabase.secretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}
