create table dinein.service_settings (
  tenant_id uuid primary key references dinein.tenants(id) on delete cascade,
  hours jsonb not null check (jsonb_typeof(hours) = 'array' and jsonb_array_length(hours) = 7),
  paused_until timestamptz
);
create table dinein.branch_pauses (
  branch_id uuid primary key,
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  paused_until timestamptz,
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id)
);
create table dinein.dining_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  number integer not null check (number between 1 and 999),
  label text,
  seats integer not null check (seats between 1 and 30),
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{16,}$'),
  active boolean not null default true,
  unique (tenant_id, branch_id, id),
  unique (branch_id, number),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id)
);
create table dinein.waiters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  name text not null check (char_length(btrim(name)) between 2 and 40),
  retired_at timestamptz,
  unique (tenant_id, branch_id, id),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id)
);
create table dinein.table_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  table_id uuid not null,
  status text not null default 'open' check (status in ('open', 'bill_requested', 'closed')),
  waiter_id uuid,
  opened_at timestamptz not null default now(),
  bill_requested_at timestamptz,
  closed_at timestamptz,
  closed_as text check (closed_as in ('paid', 'force_closed')),
  paid_by text check (paid_by in ('cash', 'card', 'wallet')),
  amount_paid integer check (amount_paid >= 0),
  closed_by text,
  close_reason text,
  unique (tenant_id, branch_id, table_id, id),
  foreign key (tenant_id, branch_id, table_id) references dinein.dining_tables(tenant_id, branch_id, id),
  foreign key (tenant_id, branch_id, waiter_id) references dinein.waiters(tenant_id, branch_id, id),
  check ((status = 'closed' and closed_at is not null and closed_as is not null and closed_by is not null)
      or (status <> 'closed' and closed_at is null and closed_as is null and closed_by is null and paid_by is null and amount_paid is null and close_reason is null)),
  check (closed_as is distinct from 'paid' or (paid_by is not null and amount_paid is not null)),
  check (closed_as is distinct from 'force_closed' or (close_reason is not null and char_length(btrim(close_reason)) >= 5 and paid_by is null and amount_paid is null))
);
create unique index table_sessions_one_unclosed on dinein.table_sessions (table_id) where status <> 'closed';

create table dinein.order_counters (
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  day date not null,
  last_number integer not null check (last_number >= 1200),
  primary key (tenant_id, day)
);
create table dinein.orders (
  id uuid primary key default gen_random_uuid(),
  number integer not null check (number >= 1200),
  business_day date not null,
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  table_number integer,
  table_id uuid,
  session_id uuid,
  waiter_id uuid,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 30),
  total integer not null check (total >= 0),
  notes text check (char_length(notes) <= 200),
  status text not null check (status in ('new', 'accepted', 'served', 'cancelled')),
  source text not null check (source in ('qr', 'staff')),
  entered_by text not null check (entered_by in ('customer', 'staff')),
  entered_by_name text,
  cancel_reason text,
  cancelled_by text,
  history jsonb not null default '[]' check (jsonb_typeof(history) = 'array'),
  created_at timestamptz not null default now(),
  finished_at timestamptz, -- when served or cancelled; sorts the completed list and void log
  unique (tenant_id, branch_id, id),
  unique (tenant_id, business_day, number),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id),
  foreign key (tenant_id, branch_id, table_id, session_id) references dinein.table_sessions(tenant_id, branch_id, table_id, id),
  foreign key (tenant_id, branch_id, waiter_id) references dinein.waiters(tenant_id, branch_id, id),
  check ((table_id is null) = (session_id is null)),
  check (status <> 'cancelled' or (cancel_reason is not null and char_length(btrim(cancel_reason)) >= 3 and cancelled_by is not null)),
  check ((status in ('served', 'cancelled')) = (finished_at is not null))
);
create table dinein.diner_order_refs (
  client_ref text primary key,
  tenant_id uuid not null,
  branch_id uuid not null,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, branch_id, order_id) references dinein.orders(tenant_id, branch_id, id) on delete cascade
);
create table dinein.service_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  table_id uuid not null,
  table_number integer not null,
  session_id uuid not null,
  kind text not null check (kind in ('water', 'roti', 'napkins', 'cutlery', 'waiter', 'bill')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by text,
  foreign key (tenant_id, branch_id, table_id, session_id) references dinein.table_sessions(tenant_id, branch_id, table_id, id),
  check ((handled_at is null) = (handled_by is null))
);
create unique index service_requests_one_open_kind on dinein.service_requests (session_id, kind) where handled_at is null;
create table dinein.cash_closes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  branch_id uuid not null,
  day date not null,
  expected_cash integer not null check (expected_cash >= 0),
  counted_cash integer not null check (counted_cash >= 0),
  difference integer generated always as (counted_cash - expected_cash) stored,
  note text,
  closed_by text not null,
  closed_at timestamptz not null default now(),
  unique (branch_id, day),
  foreign key (tenant_id, branch_id) references dinein.branches(tenant_id, id),
  check (counted_cash = expected_cash or (note is not null and char_length(btrim(note)) > 0))
);
