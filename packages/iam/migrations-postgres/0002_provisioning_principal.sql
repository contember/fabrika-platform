-- The SEEDED PROVISIONING identity — the Postgres twin of `../migrations/0008_provisioning_principal.sql`.
--
-- `resolveCaller` (src/auth.ts) resolves a bearer matching the PROPUSTKA_PROVISIONING_KEY secret to a
-- synthetic global-admin with this id: the machine analog of the IAM_BOOTSTRAP_ADMINS email
-- bootstrap, used to bring a control plane up before any DB-backed admin credential exists. The row
-- exists so the audit that key drives (iam.app.schema.reconcile, issued_by on issueKey, …) resolves
-- its principal_id FK.
--
-- Byte-for-byte the same statement as the SQLite file: `ON CONFLICT DO NOTHING` (not `INSERT OR
-- IGNORE`, which is SQLite-only) and a fixed `created_at` literal, because a migration cannot bind a
-- parameter and `unixepoch()`/`now()` would pin the file to one dialect. The literal is the
-- authoring date of the original migration — this is a synthetic bootstrap identity, so its exact
-- creation time is meaningless beyond ordering. Idempotent; safe to re-run.
INSERT INTO principals (id, type, external_id, email, label, disabled_at, created_at) VALUES
  ('provisioning-admin', 'service', NULL, NULL, 'provisioning', NULL, 1782561600)
  ON CONFLICT DO NOTHING;
