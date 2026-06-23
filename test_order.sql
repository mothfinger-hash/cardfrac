-- ─────────────────────────────────────────────────────────────────────────
-- Create a FAKE paid order to test the Shippo "Ship Order" flow.
-- Keyed to an EXPLICIT seller id so it can't land on the wrong account.
--
-- STEP 0: get your logged-in user id from the browser console:
--           currentUser.id
--         Paste it in place of  PASTE_YOUR_USER_ID  below (keep the quotes).
--
-- Run migration_shipping_addresses.sql FIRST (needs the ship_to_* columns).
-- ─────────────────────────────────────────────────────────────────────────

-- (A) Did a previous attempt land, and on which seller?
select id, seller_id, buyer_id, status, ship_to_city
from public.orders
where stripe_session_id = 'TEST_ORDER_DELETE_ME';

-- (B) Clear any prior attempt so we don't stack duplicates.
delete from public.orders where stripe_session_id = 'TEST_ORDER_DELETE_ME';

-- (C) Create the test order for YOUR current account.
insert into public.orders (
  buyer_id, seller_id, amount, platform_fee, seller_payout, status,
  payment_route, stripe_session_id,
  ship_to_name, ship_to_street1, ship_to_street2,
  ship_to_city, ship_to_state, ship_to_zip, ship_to_country, ship_to_phone, ship_to_email
)
select
  (select id from public.profiles
     where id <> 'PASTE_YOUR_USER_ID' order by created_at limit 1) as buyer_id,
  'PASTE_YOUR_USER_ID'::uuid                                       as seller_id,
  5.00, 0.40, 4.60, 'paid',
  'platform_only', 'TEST_ORDER_DELETE_ME',
  'Test Buyer', '215 Clayton St', '',
  'San Francisco', 'CA', '94117', 'US', '4151234567', 'test-buyer@example.com';

-- (D) Confirm it now exists for you:
select id, seller_id, status, ship_to_city
from public.orders
where stripe_session_id = 'TEST_ORDER_DELETE_ME';

-- Cleanup when done:
-- delete from public.orders where stripe_session_id = 'TEST_ORDER_DELETE_ME';
