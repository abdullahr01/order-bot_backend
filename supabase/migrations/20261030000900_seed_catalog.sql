-- Guide 5.1-5.3: initial editable catalogue, not ongoing entitlement enforcement.
-- Future product-phase features are stored but remain locked by Phase 2 plumbing.
insert into dinein.catalog_plans (id, name, monthly_price, setup_fee, features, limits) values
('starter', 'Starter', 15000, 30000,
 '["qr_ordering","bill_request","quick_requests","kot_printing","offline_counter","owner_live_view","daily_summary","void_log","cash_close","reports_basic"]',
 '{"tables":10,"staff_accounts":3,"stations":1,"branches":1}'),
('growth', 'Growth', 25000, 40000,
 '["qr_ordering","bill_request","quick_requests","kot_printing","offline_counter","owner_live_view","daily_summary","void_log","cash_close","reports_basic","station_routing","time_menus","leak_reconciliation","reports_full","upsell_rules","split_bill","review_prompt"]',
 '{"tables":20,"staff_accounts":6,"stations":4,"branches":1}'),
('pro', 'Pro', 35000, 50000,
 '["qr_ordering","bill_request","quick_requests","kot_printing","offline_counter","owner_live_view","daily_summary","void_log","cash_close","reports_basic","station_routing","time_menus","priority_support","leak_reconciliation","reports_full","upsell_rules","split_bill","review_prompt","pra_invoicing","loyalty","kds","menu_import","finance_summary"]',
 '{"tables":50,"staff_accounts":10,"stations":null,"branches":1}');

insert into dinein.catalog_addons (id, name, monthly_price, plan_share, available_to, features, limit_key, units) values
('extra_tables','Extra tables',1000,null,array['starter','growth','pro'],'[]','tables',1),
('extra_staff','Extra staff login',500,null,array['starter','growth','pro'],'[]','staff_accounts',1),
('extra_station','Extra kitchen station',1500,null,array['starter'],'["station_routing"]','stations',1),
('extra_branch','Additional branch',null,80,array['starter','growth','pro'],'["multi_branch"]','branches',1);
