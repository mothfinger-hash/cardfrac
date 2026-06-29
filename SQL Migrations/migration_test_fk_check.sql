-- Single query, both columns side-by-side so the output is unambiguous.
SELECT
  table_name || '.' || column_name AS column_ref,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'catalog'  AND column_name = 'id')
    OR (table_name = 'profiles' AND column_name = 'id')
  )
ORDER BY table_name;

-- Expected output:
--   catalog.id   | text  | NO
--   profiles.id  | uuid  | NO
--
-- If catalog.id shows as anything other than text/character varying,
-- paste it back — I'll adjust the FK type in the main migration.
