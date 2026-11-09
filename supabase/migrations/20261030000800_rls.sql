-- Access model (agreed 2026-11-09): the API connects as the database owner and
-- scopes every query by the verified tenant/branch itself. RLS is switched on
-- with no policies, so any other route into these tables sees nothing.
revoke all on all tables in schema dinein from public, anon, authenticated, service_role;

do $$
declare item text;
begin
  for item in select tablename from pg_tables where schemaname = 'dinein' loop
    execute format('alter table dinein.%I enable row level security', item);
  end loop;
end;
$$;
