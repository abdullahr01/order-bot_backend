create table dinein.counter_pins (
  user_id uuid primary key,
  tenant_id uuid not null,
  pin_hash text not null check (pin_hash like '$argon2id$%' or pin_hash ~ '^\$2[aby]\$'),
  failures integer not null default 0 check (failures >= 0),
  held_until timestamptz,
  unique (tenant_id, user_id),
  foreign key (tenant_id, user_id) references dinein.team_members(tenant_id, id) on delete cascade
);
create table dinein.counter_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  name text not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  paired_at timestamptz not null default now(),
  paired_by text not null,
  last_seen_at timestamptz,
  unique (tenant_id, branch_id, id),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id)
);
create table dinein.pairing_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  expires_at timestamptz not null,
  created_by text not null,
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id)
);
create table dinein.counter_unlocks (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid not null,
  branch_id uuid not null,
  device_id uuid not null unique,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, branch_id, device_id) references dinein.counter_devices(tenant_id, branch_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references dinein.counter_pins(tenant_id, user_id) on delete cascade
);
