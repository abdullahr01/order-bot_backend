create table dinein.stations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 30),
  position integer not null check (position >= 0),
  unique (tenant_id, id)
);
create unique index stations_name_unique on dinein.stations (tenant_id, lower(btrim(name)));
create table dinein.menu_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 40),
  position integer not null check (position >= 0),
  station_id uuid,
  schedule jsonb check (jsonb_typeof(schedule) = 'object'),
  unique (tenant_id, id),
  foreign key (tenant_id, station_id) references dinein.stations(tenant_id, id) on delete set null (station_id)
);
create unique index menu_categories_name_unique on dinein.menu_categories (tenant_id, lower(btrim(name)));
create table dinein.menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  category_id uuid not null,
  name text not null,
  description text,
  price integer not null check (price between 1 and 100000),
  photo_url text,
  available boolean not null default true,
  sold_out_until timestamptz,
  position integer not null check (position >= 0),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 5),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, category_id) references dinein.menu_categories(tenant_id, id)
);
create table dinein.menu_versions (
  tenant_id uuid primary key references dinein.tenants(id) on delete cascade,
  version integer not null default 1 check (version > 0)
);
