-- Private application schemas: not exposed through the Supabase Data API.
create schema dinein;
create schema dinein_private;
revoke all on schema dinein, dinein_private from public;

create table dinein.catalog_plans (
  id text primary key,
  name text not null,
  monthly_price integer not null check (monthly_price >= 0),
  setup_fee integer not null check (setup_fee >= 0),
  tagline text,
  features jsonb not null default '[]' check (jsonb_typeof(features) = 'array'),
  limits jsonb not null default '{}' check (jsonb_typeof(limits) = 'object'),
  updated_at timestamptz not null default now()
);

create table dinein.catalog_addons (
  id text primary key,
  name text not null,
  monthly_price integer check (monthly_price > 0),
  plan_share integer check (plan_share between 1 and 100),
  available_to text[] not null check (cardinality(available_to) > 0),
  features jsonb not null default '[]' check (jsonb_typeof(features) = 'array'),
  limit_key text not null,
  units integer not null default 1 check (units > 0),
  updated_at timestamptz not null default now(),
  check ((monthly_price is null) <> (plan_share is null))
);
