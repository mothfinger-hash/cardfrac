-- Native push notification device tokens (FCM / APNs via
-- @capacitor/push-notifications). One token per user for v1 (last-registered
-- device wins). The server-side sender (/api/send-push) reads these. Idempotent.

alter table public.profiles add column if not exists push_token     text;
alter table public.profiles add column if not exists push_platform   text;   -- 'ios' | 'android'
alter table public.profiles add column if not exists push_updated_at timestamptz;
