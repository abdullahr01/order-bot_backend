create table dinein.tenant_addons (
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  addon_id text not null references dinein.catalog_addons(id),
  quantity integer not null check (quantity between 1 and 200),
  activated_at timestamptz not null default now(),
  cancels_at timestamptz,
  primary key (tenant_id, addon_id)
);
create table dinein.tenant_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  feature_key text,
  limit_key text,
  limit_value integer check (limit_value >= 0),
  granted boolean,
  reason text not null check (char_length(btrim(reason)) >= 5),
  expires_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((feature_key is not null and limit_key is null and granted is not null and limit_value is null)
      or (limit_key is not null and feature_key is null and granted is null))
);
create unique index tenant_override_feature_unique on dinein.tenant_overrides (tenant_id, feature_key) where feature_key is not null;
create unique index tenant_override_limit_unique on dinein.tenant_overrides (tenant_id, limit_key) where limit_key is not null;

create table dinein.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  kind text not null check (kind in ('monthly', 'setup')),
  month date,
  amount integer not null check (amount > 0),
  method text not null check (method in ('cash', 'cheque', 'bank_transfer', 'easypaisa', 'jazzcash', 'card')),
  reference text check (char_length(reference) <= 60),
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  check (kind <> 'monthly' or month is not null),
  check (month is null or extract(day from month) = 1),
  check (method = 'cash' or char_length(btrim(reference)) > 0 and reference is not null)
);
create unique index payments_monthly_unique on dinein.payments (tenant_id, month) where kind = 'monthly';
create unique index payments_setup_unique on dinein.payments (tenant_id) where kind = 'setup';

create table dinein.entitlement_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references dinein.tenants(id), -- null for platform catalogue writes
  tenant_name text,
  action text not null,
  feature_key text,
  actor text not null,
  before jsonb,
  after jsonb,
  reason text not null check (char_length(btrim(reason)) >= 5),
  created_at timestamptz not null default now()
);
create function dinein_private.reject_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = 'Audit records are append-only.';
end;
$$;
revoke all on function dinein_private.reject_audit_change() from public;
create trigger entitlement_events_immutable before update or delete on dinein.entitlement_events
  for each row execute function dinein_private.reject_audit_change();
create trigger entitlement_events_no_truncate before truncate on dinein.entitlement_events
  for each statement execute function dinein_private.reject_audit_change();

create table dinein.upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  feature_key text,
  limit_key text,
  requested_by text not null,
  count integer not null default 1 check (count > 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'handled')),
  handled_by text,
  handled_at timestamptz,
  note text,
  check ((feature_key is null) <> (limit_key is null)),
  check ((status = 'open' and handled_at is null and handled_by is null)
      or (status = 'handled' and handled_at is not null and handled_by is not null))
);
create unique index upgrade_requests_open_feature on dinein.upgrade_requests (tenant_id, feature_key) where status = 'open' and feature_key is not null;
create unique index upgrade_requests_open_limit on dinein.upgrade_requests (tenant_id, limit_key) where status = 'open' and limit_key is not null;

create table dinein.locked_clicks (
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  feature_key text not null,
  clicks integer not null default 0 check (clicks >= 0),
  primary key (tenant_id, feature_key)
);
create table dinein.audit_runs (
  month date primary key check (extract(day from month) = 1),
  reviewed text[] not null default '{}',
  notes text,
  completed_at timestamptz,
  completed_by text,
  check ((completed_at is null) = (completed_by is null))
);
