-- Aligns the schema with the partner's packages/core (reviewed 2026-11-09):
-- country price lists, UK partners, and column types the API contract expects.

-- Each country has its own price list. Plan and add-on ids are fixed in code,
-- so subscriptions check the id and read the row for the restaurant's country.
create table dinein.catalog_countries (
  country text primary key check (country in ('PK', 'GB')),
  prices_confirmed boolean not null default false
);
insert into dinein.catalog_countries (country, prices_confirmed) values ('PK', true), ('GB', false);

alter table dinein.subscriptions drop constraint subscriptions_plan_id_fkey;
alter table dinein.subscriptions drop constraint subscriptions_scheduled_plan_id_fkey;
alter table dinein.tenant_addons drop constraint tenant_addons_addon_id_fkey;
alter table dinein.subscriptions add constraint subscriptions_plan_id_check check (plan_id in ('starter', 'growth', 'pro'));
alter table dinein.subscriptions add constraint subscriptions_scheduled_plan_id_check check (scheduled_plan_id in ('starter', 'growth', 'pro'));
alter table dinein.tenant_addons add constraint tenant_addons_addon_id_check check (addon_id in ('extra_tables', 'extra_staff', 'extra_station', 'extra_branch'));

alter table dinein.catalog_plans add column country text not null default 'PK' references dinein.catalog_countries(country);
alter table dinein.catalog_plans alter column country drop default;
alter table dinein.catalog_plans drop constraint catalog_plans_pkey;
alter table dinein.catalog_plans add primary key (country, id);

alter table dinein.catalog_addons add column country text not null default 'PK' references dinein.catalog_countries(country);
alter table dinein.catalog_addons alter column country drop default;
alter table dinein.catalog_addons drop constraint catalog_addons_pkey;
alter table dinein.catalog_addons add primary key (country, id);

update dinein.catalog_plans p set tagline = v.tagline
from (values
  ('starter', 'Cafés and small family restaurants'),
  ('growth', 'Busy family and BBQ restaurants'),
  ('pro', 'Large restaurants and those needing PRA invoicing')
) as v(id, tagline)
where p.country = 'PK' and p.id = v.id;

-- UK starting prices are placeholders until the founder confirms them.
insert into dinein.catalog_plans (country, id, name, monthly_price, setup_fee, tagline, features, limits)
select 'GB', p.id, p.name, v.monthly_price, v.setup_fee, v.tagline, p.features, p.limits
from dinein.catalog_plans p
join (values
  ('starter', 99, 199, 'Cafés and small family restaurants'),
  ('growth', 169, 299, 'Busy curry houses and grills'),
  ('pro', 249, 399, 'Large restaurants and groups')
) as v(id, monthly_price, setup_fee, tagline) on v.id = p.id
where p.country = 'PK';

insert into dinein.catalog_addons (country, id, name, monthly_price, plan_share, available_to, features, limit_key, units)
select 'GB', a.id, a.name, v.monthly_price, a.plan_share, a.available_to, a.features, a.limit_key, a.units
from dinein.catalog_addons a
join (values
  ('extra_tables', 5),
  ('extra_staff', 5),
  ('extra_station', 10),
  ('extra_branch', null::integer)
) as v(id, monthly_price) on v.id = a.id
where a.country = 'PK';

-- Companies that sign up restaurants in a country and pay us a share of the fees.
create table dinein.partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  countries text[] not null check (cardinality(countries) > 0 and countries <@ array['PK', 'GB']::text[]),
  contact_name text not null,
  contact_email text not null,
  share_percent numeric(5, 2) check (share_percent > 0 and share_percent <= 100),
  payment_day integer check (payment_day between 1 and 28),
  created_at timestamptz not null default now()
);
create table dinein.partner_settlements (
  partner_id uuid not null references dinein.partners(id),
  month date not null check (extract(day from month) = 1),
  amount numeric(12, 2) not null check (amount > 0),
  reference text not null default '' check (char_length(reference) <= 60),
  received_at timestamptz not null default now(),
  recorded_by text not null,
  primary key (partner_id, month)
);

alter table dinein.tenants add column partner_id uuid references dinein.partners(id);
alter table dinein.tenants add constraint tenants_country_check check (country in ('PK', 'GB'));
create index tenants_partner on dinein.tenants (partner_id) where partner_id is not null;
create index tenants_country on dinein.tenants (country);

-- Core sends one tax profile name, not an object.
alter table dinein.tenants drop constraint tenants_tax_profile_check;
alter table dinein.tenants alter column tax_profile drop default;
alter table dinein.tenants alter column tax_profile type text using 'pk_pra'::text;
alter table dinein.tenants alter column tax_profile set default 'pk_pra';
alter table dinein.tenants add constraint tenants_tax_profile_check check (tax_profile in ('pk_pra', 'gb_vat'));

-- Core's IsoDate. The local day is still worked out in the restaurant's time zone.
alter table dinein.subscriptions alter column billing_starts_at type timestamptz using billing_starts_at::timestamptz;

-- Events store display text. The API requires a reason on admin writes; a partner
-- payment may carry only a short reference, or none.
alter table dinein.entitlement_events alter column "before" type text using "before"::text;
alter table dinein.entitlement_events alter column "after" type text using "after"::text;
alter table dinein.entitlement_events drop constraint entitlement_events_reason_check;
alter table dinein.entitlement_events alter column reason drop not null;
alter table dinein.entitlement_events add column country text check (country in ('PK', 'GB'));

-- A new override ends the old one and adds a row; the newest live row wins.
drop index dinein.tenant_override_feature_unique;
drop index dinein.tenant_override_limit_unique;
create index tenant_overrides_tenant on dinein.tenant_overrides (tenant_id, created_at desc);

-- A retired table's number can be used again.
alter table dinein.dining_tables drop constraint dining_tables_branch_id_number_key;
create unique index dining_tables_active_number on dinein.dining_tables (branch_id, number) where active;

create unique index waiters_name_unique on dinein.waiters (branch_id, lower(btrim(name))) where retired_at is null;

-- Same lock-out as every other business table.
revoke all on dinein.catalog_countries, dinein.partners, dinein.partner_settlements from public, anon, authenticated, service_role;
alter table dinein.catalog_countries enable row level security;
alter table dinein.partners enable row level security;
alter table dinein.partner_settlements enable row level security;
