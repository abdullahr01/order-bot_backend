create index orders_branch_created on dinein.orders (tenant_id, branch_id, created_at desc);
create index orders_session on dinein.orders (session_id);
create index orders_in_progress on dinein.orders (tenant_id, status) where status in ('new', 'accepted');
create index orders_branch_finished on dinein.orders (tenant_id, branch_id, finished_at desc) where finished_at is not null;
create index sessions_branch_closed on dinein.table_sessions (branch_id, closed_at);
create index requests_unhandled on dinein.service_requests (session_id) where handled_at is null;
create index requests_branch_open on dinein.service_requests (branch_id, created_at) where handled_at is null;
create index requests_branch_recent on dinein.service_requests (branch_id, handled_at desc) where handled_at is not null;
create index audit_tenant_created on dinein.entitlement_events (tenant_id, created_at desc);
create index audit_created on dinein.entitlement_events (created_at desc);
create index order_refs_expiry on dinein.diner_order_refs (created_at);
create index pairing_codes_expiry on dinein.pairing_codes (expires_at);
create index team_members_branch on dinein.team_members (tenant_id, branch_id);
create index counter_unlocks_user on dinein.counter_unlocks (tenant_id, user_id);
create index menu_items_category on dinein.menu_items (tenant_id, category_id, position);

-- Enforce the branch relationship that cannot be expressed by a simple FK:
-- the owner may unlock anywhere, staff only at their assigned branch.
create function dinein_private.check_unlock_branch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from dinein.team_members m
    where m.id = new.user_id and m.tenant_id = new.tenant_id
      and (m.role = 'tenant_owner' or m.branch_id = new.branch_id)
  ) then
    raise exception using errcode = '23514', message = 'Counter user must belong to the device branch.', constraint = 'counter_unlock_branch';
  end if;
  return new;
end;
$$;
revoke all on function dinein_private.check_unlock_branch() from public;
create trigger counter_unlock_branch before insert or update on dinein.counter_unlocks
  for each row execute function dinein_private.check_unlock_branch();

-- Moving staff or changing/removing their PIN revokes existing unlocks.
create function dinein_private.revoke_member_unlocks() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'team_members' then
    if new.branch_id is distinct from old.branch_id or new.role is distinct from old.role or new.tenant_id is distinct from old.tenant_id then
      delete from dinein.counter_unlocks where user_id = old.id;
    end if;
  else
    if new.pin_hash is distinct from old.pin_hash then
      delete from dinein.counter_unlocks where user_id = old.user_id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function dinein_private.revoke_member_unlocks() from public;
create trigger member_unlocks_revoked after update on dinein.team_members
  for each row execute function dinein_private.revoke_member_unlocks();
create trigger pin_unlocks_revoked after update on dinein.counter_pins
  for each row execute function dinein_private.revoke_member_unlocks();
