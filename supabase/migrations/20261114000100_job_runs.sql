-- The daily jobs' notebook (Stage 6, agreed 2026-11-14). Each piece of work a job
-- finishes is written down once, for example the day-7 email for one restaurant's
-- unpaid period, so a second run, an overlapping run or a restart never repeats it.
-- A job claims its row first; a failed email gives the row back to retry next day.
create table dinein.job_runs (
  job text not null check (job ~ '^[a-z][a-z0-9_]{2,39}$'),
  run_key text not null check (char_length(run_key) between 1 and 200),
  tenant_id uuid references dinein.tenants(id) on delete cascade,
  done_at timestamptz not null default now(),
  primary key (job, run_key)
);
create index job_runs_tenant on dinein.job_runs (tenant_id) where tenant_id is not null;

-- Same lock-out as every other business table.
revoke all on dinein.job_runs from public, anon, authenticated, service_role;
alter table dinein.job_runs enable row level security;
