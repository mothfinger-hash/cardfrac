-- ============================================================
-- PathBinder — Direct messages
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- 1:1 user messaging. No groups, no threads with metadata — a thread
-- is implicit: every (sender, recipient) pair shares one. Each row is
-- a single message; the inbox view groups by (least(a,b), greatest(a,b))
-- to render conversations.
--
-- Block-aware: the RLS policy blocks INSERTs where the recipient has
-- blocked the sender. Anything-goes for reads on your own messages.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.direct_messages (
  id              bigserial   PRIMARY KEY,
  sender_id       uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body            text        NOT NULL,
  -- Optional context — links a message to a listing or order so the UI
  -- can render "Re: Charizard" header. NULL for general conversations.
  listing_id      uuid,
  order_id        uuid,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id),
  CHECK (char_length(body) BETWEEN 1 AND 4000)
);

COMMENT ON TABLE public.direct_messages IS
  '1:1 user messaging. Thread is implicit per (sender, recipient) pair.';

-- Hot-path indexes: inbox load by recipient, thread load by pair.
CREATE INDEX IF NOT EXISTS idx_dm_recipient_recent
  ON public.direct_messages (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_thread
  ON public.direct_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread
  ON public.direct_messages (recipient_id, read_at)
  WHERE read_at IS NULL;

ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;

-- READ: only the two participants can read messages in their thread.
DROP POLICY IF EXISTS "Participants read messages" ON public.direct_messages;
CREATE POLICY "Participants read messages"
  ON public.direct_messages FOR SELECT
  TO authenticated
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

-- INSERT: sender_id must be the caller, AND the recipient must not
-- have blocked the sender. Spam guard: anyone authenticated, but
-- blocks are honored. (UI also enforces this client-side.)
DROP POLICY IF EXISTS "Users send their own messages" ON public.direct_messages;
CREATE POLICY "Users send their own messages"
  ON public.direct_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND NOT EXISTS (
      SELECT 1 FROM public.blocked_users
      WHERE blocker_id = recipient_id AND blocked_id = auth.uid()
    )
  );

-- UPDATE: only the recipient can mark a message read (set read_at).
DROP POLICY IF EXISTS "Recipient marks read" ON public.direct_messages;
CREATE POLICY "Recipient marks read"
  ON public.direct_messages FOR UPDATE
  TO authenticated
  USING (recipient_id = auth.uid())
  WITH CHECK (recipient_id = auth.uid());


-- Convenience: unread count per user. View, so it stays live.
CREATE OR REPLACE VIEW public.dm_unread_counts AS
  SELECT recipient_id AS user_id, count(*)::int AS unread
  FROM public.direct_messages
  WHERE read_at IS NULL
  GROUP BY recipient_id;
GRANT SELECT ON public.dm_unread_counts TO authenticated;


-- RPC: load the inbox — one row per unique conversation partner with
-- the most recent message preview + unread count. Used by the inbox
-- view so we don't have to round-trip per thread.
CREATE OR REPLACE FUNCTION public.dm_inbox(p_user_id uuid)
RETURNS TABLE(
  partner_id     uuid,
  last_message   text,
  last_at        timestamptz,
  last_sender    uuid,
  unread_count   int
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH msgs AS (
    SELECT
      CASE WHEN sender_id = p_user_id THEN recipient_id ELSE sender_id END AS partner,
      body, created_at, sender_id, read_at
    FROM public.direct_messages
    WHERE sender_id = p_user_id OR recipient_id = p_user_id
  ),
  latest AS (
    SELECT DISTINCT ON (partner)
      partner, body, created_at, sender_id
    FROM msgs
    ORDER BY partner, created_at DESC
  ),
  unread AS (
    SELECT
      CASE WHEN sender_id = p_user_id THEN recipient_id ELSE sender_id END AS partner,
      count(*)::int AS n
    FROM public.direct_messages
    WHERE recipient_id = p_user_id AND read_at IS NULL
    GROUP BY partner
  )
  SELECT
    l.partner       AS partner_id,
    l.body          AS last_message,
    l.created_at    AS last_at,
    l.sender_id     AS last_sender,
    COALESCE(u.n, 0) AS unread_count
  FROM latest l
  LEFT JOIN unread u USING (partner)
  ORDER BY l.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.dm_inbox(uuid) TO authenticated;


-- ============================================================
-- Verify:
--   SELECT count(*) FROM direct_messages;
--   SELECT * FROM dm_inbox(auth.uid()) LIMIT 5;
-- ============================================================
