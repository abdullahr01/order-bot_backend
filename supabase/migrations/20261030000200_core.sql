create table dinein.tenants (
  id uuid primary key default gen_random_uuid(),
  business_name text not null check (char_length(btrim(business_name)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  city text not null,
  owner_name text not null,
  owner_phone text not null,
  owner_email text not null,
  country text not null default 'PK',
  currency text not null default 'PKR',
  timezone text not null default 'Asia/Karachi',
  tax_profile jsonb not null default '{}' check (jsonb_typeof(tax_profile) = 'object'),
  onboarding jsonb default '{"completed_steps":[],"completed_at":null}' check (jsonb_typeof(onboarding) = 'object'), -- null = no checklist (409 no_onboarding)
  created_at timestamptz not null default now(),
  last_order_at timestamptz
);
create unique index tenants_business_name_unique on dinein.tenants (lower(btrim(business_name)));
create unique index tenants_owner_email_unique on dinein.tenants (lower(btrim(owner_email)));

create table dinein.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  area text not null,
  is_main boolean not null default false,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (not is_main or retired_at is null)
);
create unique index branches_name_unique on dinein.branches (tenant_id, lower(btrim(name))) where retired_at is null;
create unique index branches_one_main on dinein.branches (tenant_id) where is_main;

create table dinein.team_members (
  id uuid primary key references auth.users(id),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  email text not null,
  role text not null check (role in ('tenant_owner', 'tenant_staff')),
  branch_id uuid,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id),
  check ((role = 'tenant_owner' and branch_id is null) or (role = 'tenant_staff' and branch_id is not null))
);
create unique index team_members_email_unique on dinein.team_members (lower(btrim(email)));
create unique index team_members_one_owner on dinein.team_members (tenant_id) where role = 'tenant_owner';

create table dinein.subscriptions (
  tenant_id uuid primary key references dinein.tenants(id) on delete cascade,
  plan_id text not null references dinein.catalog_plans(id),
  status text not null check (status in ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  past_due_since timestamptz,
  scheduled_plan_id text references dinein.catalog_plans(id),
  billing_starts_at date,
  setup_fee integer not null check (setup_fee >= 0)
);

-- Deferred so tenant + first branch can be inserted in the same transaction.
create function dinein_private.check_main_branch() returns trigger
language plpgsql set search_path = '' as $$
declare target uuid;
begin
  if tg_table_name = 'tenants' then target := new.id;
  elsif tg_op = 'DELETE' then target := old.tenant_id;
  else target := new.tenant_id;
  end if;
  perform 1 from dinein.tenants where id = target for update;
  if found and (select count(*) from dinein.branches where tenant_id = target and is_main) <> 1 then
    raise exception using errcode = '23514', message = 'A restaurant must have exactly one main branch.', constraint = 'tenant_main_branch_required';
  end if;
  if tg_table_name = 'branches' then
    if tg_op = 'UPDATE' and old.tenant_id <> new.tenant_id then
      perform 1 from dinein.tenants where id = old.tenant_id for update;
      if found and (select count(*) from dinein.branches where tenant_id = old.tenant_id and is_main) <> 1 then
        raise exception using errcode = '23514', message = 'A restaurant must have exactly one main branch.', constraint = 'tenant_main_branch_required';
      end if;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function dinein_private.check_main_branch() from public;
create constraint trigger tenant_main_branch_required after insert on dinein.tenants
  deferrable initially deferred for each row execute function dinein_private.check_main_branch();
create constraint trigger branch_main_required after insert or update or delete on dinein.branches
  deferrable initially deferred for each row execute function dinein_private.check_main_branch();
