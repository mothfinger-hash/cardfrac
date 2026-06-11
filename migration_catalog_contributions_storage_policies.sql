-- ============================================================
-- Storage policies for the catalog-contributions bucket.
-- Idempotent — drops existing policies before recreating.
-- Run AFTER:
--   1. migration_catalog_image_contributions.sql (creates the
--      user_can_contribute_image function)
--   2. Manual creation of the "catalog-contributions" bucket in
--      Supabase Dashboard → Storage → New bucket (public: yes)
-- ============================================================

-- Drop existing policies if present (from partial earlier attempts).
DROP POLICY IF EXISTS "contrib_upload_eligible" ON storage.objects;
DROP POLICY IF EXISTS "contrib_public_read"     ON storage.objects;
DROP POLICY IF EXISTS "contrib_admin_delete"    ON storage.objects;
DROP POLICY IF EXISTS "contrib_admin_update"    ON storage.objects;

-- INSERT: authenticated users can upload IF they pass the
-- eligibility check. RLS on the contributions table separately
-- verifies the row insert; this gates the storage write.
CREATE POLICY "contrib_upload_eligible"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'catalog-contributions'
    AND public.user_can_contribute_image(auth.uid())
  );

-- SELECT: public. The bucket itself is configured public; the
-- explicit policy is belt-and-suspenders in case the bucket
-- default ever changes.
CREATE POLICY "contrib_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'catalog-contributions');

-- DELETE: admins only. Used when an approved photo gets flagged
-- as wrong and we want to roll back, OR to clean up rejected
-- submissions that should never serve.
CREATE POLICY "contrib_admin_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'catalog-contributions'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- UPDATE: admins only. Same rationale as delete — only a moderator
-- should be able to rename/move files in this bucket.
CREATE POLICY "contrib_admin_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'catalog-contributions'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND is_admin = true
    )
  );

-- ============================================================
-- Verify with:
--   SELECT polname
--   FROM pg_policy
--   WHERE polrelid = 'storage.objects'::regclass
--     AND polname LIKE 'contrib_%'
--   ORDER BY polname;
--
-- Should return 4 rows:
--   contrib_admin_delete
--   contrib_admin_update
--   contrib_public_read
--   contrib_upload_eligible
-- ============================================================
