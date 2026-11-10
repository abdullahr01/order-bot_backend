// Creates a founder account for the platform console in the configured Supabase project.
// No email is sent: the password is typed here, hidden, and goes only to Supabase.
// Then run `npm run check:signin` to set up the authenticator app (MFA).
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { openPrompt } from './prompt.js';

const FOUNDER_SCOPE = { role: 'founder', countries: ['PK', 'GB'], partnerId: null };
const MIN_PASSWORD = 12;

const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const secret = process.env.SUPABASE_SECRET_KEY?.trim();
const prompt = openPrompt();

try {
  if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in backend/.env.');
  const project = new URL(url).hostname.split('.')[0];
  console.log(`Creating a founder account in Supabase project "${project}".`);

  const name = await prompt.ask('Your name (shown in the audit log): ');
  const email = (await prompt.ask('Email: ')).toLowerCase();
  if (name.length < 2) throw new Error('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const password = await prompt.ask(`Password (at least ${MIN_PASSWORD} characters, hidden): `, { hidden: true });
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  if (await prompt.ask('Type it again: ', { hidden: true }) !== password) throw new Error('The passwords did not match.');
  if ((await prompt.ask(`Create a founder account for ${email}? Type yes: `)).toLowerCase() !== 'yes') throw new Error('Nothing was created.');

  const supabase = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name },
    // app_metadata can only be set by the server: the API trusts it, never user_metadata.
    app_metadata: { role: 'super_admin', admin_scope: FOUNDER_SCOPE, name },
  });
  if (error) {
    throw new Error(error.code === 'email_exists'
      ? 'An account with this email already exists. Nothing was changed.'
      : `Supabase refused the account (${error.code ?? error.status ?? 'unknown'}).`);
  }
  console.log(`Founder account created: ${data.user.id}`);
  console.log('Next: start the API (npm run dev) and run npm run check:signin to set up your authenticator app.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  prompt.close();
}
