import 'dotenv/config';
import postgres from 'postgres';
import { databaseConfig, assertDevelopmentTarget } from '../db/config.js';

let sql;
try {
  assertDevelopmentTarget();
  const config = databaseConfig(process.env);
  sql = postgres(config.url, { ...config.options, max: 1 });
  const [server] = await sql`select current_user as role, current_setting('server_version_num')::integer as version`;
  const [tables] = await sql`select count(*)::integer as total, count(*) filter (where c.relrowsecurity)::integer as rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dinein' and c.relkind = 'r'`;
  const publicTables = await sql`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  const [history] = await sql`select to_regclass('supabase_migrations.schema_migrations') is not null as exists`;
  const migrations = history.exists ? await sql`select version, name from supabase_migrations.schema_migrations order by version` : [];
  console.log(JSON.stringify({ server, dineinTables: tables, publicTables: publicTables.map((row) => row.tablename), migrations }, null, 2));
} catch (error) {
  // Config errors use static messages; database errors can contain secrets/data.
  console.error(JSON.stringify({ operation: 'databaseInspect', code: /^[A-Z0-9_]{5,40}$/.test(error.code || '') ? error.code : undefined,
    message: sql ? 'Database inspection failed; check connectivity, TLS and credentials.' : error.message }));
  process.exitCode = 1;
} finally { if (sql) await sql.end({ timeout: 5 }); }
