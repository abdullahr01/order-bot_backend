// Signs in to Supabase as a platform-team member, as the console will, and calls the API.
// The first time, it sets up the authenticator app (TOTP). It proves real sign-in and MFA
// work end to end. Tokens are never printed; the setup key is shown once, for enrolment.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { openPrompt } from './prompt.js';

const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
const api = (process.env.API_URL?.trim() || 'http://localhost:4000').replace(/\/$/, '');
const prompt = openPrompt();
const supabase = url && publishable
  ? createClient(url, publishable, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } })
  : null;

const failed = (step, error) => new Error(`${step} failed (${error?.code ?? error?.status ?? 'unknown'}).`);

try {
  if (!supabase) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in backend/.env.');
  const email = (await prompt.ask('Email: ')).toLowerCase();
  const password = await prompt.ask('Password (hidden): ', { hidden: true });
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error) throw failed('Sign-in', signIn.error);
  console.log('Password accepted.');

  const factors = await supabase.auth.mfa.listFactors();
  if (factors.error) throw failed('Reading authenticators', factors.error);
  let factorId = factors.data.totp.find((factor) => factor.status === 'verified')?.id;

  if (!factorId) {
    // A setup that was started but never finished is removed and started again.
    for (const factor of factors.data.all.filter((entry) => entry.factor_type === 'totp' && entry.status !== 'verified')) {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
    const enrolled = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'QR Dine-in console' });
    if (enrolled.error) throw failed('Authenticator setup', enrolled.error);
    factorId = enrolled.data.id;
    console.log('\nSet up your authenticator app (Google or Microsoft Authenticator):');
    console.log('  Add account > Enter a setup key, time based, then enter:');
    console.log(`  Account: QR Dine-in (${email})`);
    console.log(`  Key:     ${enrolled.data.totp.secret}`);
    console.log('Anyone with this key can make your codes. Don’t share, save or screenshot it.\n');
  }

  const code = (await prompt.ask('6-digit code from the app: ')).replace(/\s/g, '');
  const verified = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (verified.error) throw failed('Code check', verified.error);
  const level = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  console.log(`Signed in with MFA (level ${level.data?.currentLevel}).`);

  const { data: { session } } = await supabase.auth.getSession();
  let response;
  try {
    response = await fetch(`${api}/admin/tenants?pageSize=1`, { headers: { authorization: `Bearer ${session.access_token}` } });
  } catch {
    throw new Error(`Could not reach the API at ${api}. Start it with npm run dev, then run this again.`);
  }
  const body = await response.json().catch(() => null);
  if (response.ok) console.log(`API accepted the sign-in: GET /admin/tenants returned ${response.status}, ${body?.total ?? 0} restaurant(s) in view.`);
  else console.log(`API refused the sign-in: ${response.status} ${body?.code ?? ''} ${body?.message ?? ''}`.trim());
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await supabase?.auth.signOut().catch(() => {});
  prompt.close();
}
