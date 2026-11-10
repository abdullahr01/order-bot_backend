-- Idempotency-Key on the counter's manual order and table close (guide §16, agreed
-- 2026-11-10). A counter that lost the answer sends the same request again with the
-- same key; the API replays the first answer instead of ordering twice or closing the
-- next party's table. Keys are per caller (one counter PC or one signed-in person) and
-- kept 24 hours; a Stage 6 job removes older ones.
create table dinein.idempotency_keys (
  tenant_id uuid not null references dinein.tenants(id) on delete cascade,
  caller text not null check (caller ~ '^(device|user):[0-9a-f-]{36}$'),
  key text not null check (char_length(key) between 8 and 200),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, caller, key)
);
create index idempotency_keys_expiry on dinein.idempotency_keys (created_at);

-- Same lock-out as every other business table.
revoke all on dinein.idempotency_keys from public, anon, authenticated, service_role;
alter table dinein.idempotency_keys enable row level security;
