-- The monthly audit is per country (agreed 2026-11-12): the console shows Pakistan and
-- the UK separately, so signing off one mustn't mark the other done. The table is empty.
alter table dinein.audit_runs add column country text not null default 'PK' check (country in ('PK', 'GB'));
alter table dinein.audit_runs alter column country drop default;
alter table dinein.audit_runs drop constraint audit_runs_pkey;
alter table dinein.audit_runs add primary key (country, month);
