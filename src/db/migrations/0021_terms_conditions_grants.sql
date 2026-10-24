-- 0021 — Let the API role use the Terms & Conditions table.
--
-- 0020 created terms_conditions but, unlike every other table migration, did
-- not end with app.grant_runtime_privileges(), so the unprivileged API role
-- was refused access ("permission denied for table terms_conditions") and the
-- sync feed failed. 0020 is already applied and checksum-protected, so the
-- missing grant is a migration of its own.

SET LOCAL search_path = public, extensions;

SELECT app.grant_runtime_privileges();
