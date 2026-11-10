// DEVELOPMENT ONLY. Sets a password on a restaurant owner's or staff member's test
// account, so they can sign in from Postman before the partner's portal and an email
// service exist. Refuses production, platform-team accounts and anyone not on a team.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { assertDevelopmentTarget, databaseConfig } from '../db/config.js';
import { openPrompt } from './prompt.js';

const MIN_PASSWORD = 12;
const prompt = openPrompt();
let sql;

try {
  // Same guard as the migration commands: never production, and only the configured project.
  assertDevelopmentTarget();
  const { url, options } = databaseConfig();
  sql = postgres(url, { ...options, max: 1 });

  const email = (await prompt.ask('Email of the owner or staff account: ')).toLowerCase();
  const [account] = await sql`
    select u.id, u.raw_app_meta_data ->> 'role' as auth_role, m.role as team_role, t.business_name
    from auth.users u
    left join dinein.team_members m on m.id = u.id
    left join dinein.tenants t on t.id = m.tenant_id
    where lower(u.email) = ${email}`;
  if (!account) throw new Error('No account has that email.');
  if (account.auth_role === 'super_admin') throw new Error('This is a platform-team account. Nothing was changed.');
  if (!account.team_role) throw new Error('That account is not on any restaurant’s team. Nothing was changed.');

  const password = await prompt.ask(`New password (at least ${MIN_PASSWORD} characters, hidden): `, { hidden: true });
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
  if (await prompt.ask('Type it again: ', { hidden: true }) !== password) throw new Error('The passwords did not match.');
  const role = account.team_role === 'tenant_owner' ? 'owner' : 'staff';
  if ((await prompt.ask(`Set this password for the ${role} of "${account.business_name}"? Type yes: `)).toLowerCase() !== 'yes') {
    throw new Error('Nothing was changed.');
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  // Confirming the email too, as accepting the invite would have.
  const { error } = await supabase.auth.admin.updateUserById(account.id, { password, email_confirm: true });
  if (error) throw new Error(`Supabase refused the change (${error.code ?? error.status ?? 'unknown'}).`);
  console.log(`Password set. The ${role} can now sign in from Postman (folder "0. Sign in").`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  prompt.close();
  await sql?.end({ timeout: 5 });
}
