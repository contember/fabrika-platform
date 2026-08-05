-- The SEEDED PROVISIONING identity. `resolveCaller` (src/auth.ts) resolves a bearer matching the
-- FABRIKA_IAM_PROVISIONING_KEY secret to a synthetic global-admin with this id — the machine analog of
-- the IAM_BOOTSTRAP_ADMINS email bootstrap, used to bring up a control plane (e.g. vozka) before any
-- DB-backed admin credential exists. Seed a stable `service` principal so the audit that key drives
-- (iam.app.schema.reconcile, issued_by on issueKey, …) resolves its principal_id FK. The prod-applied
-- analog of the dev admin's seed.dev.sql row. Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.
--
-- Portability: `INSERT OR IGNORE` is SQLite-only (`ON CONFLICT DO NOTHING` is the form both
-- dialects accept), and `created_at` is a fixed literal because `unixepoch()` does not exist in
-- Postgres and a migration has no way to bind a parameter. The literal is this migration's
-- authoring date — the row is a synthetic bootstrap identity, so its exact creation time is
-- meaningless beyond ordering.
INSERT INTO principals (id, type, external_id, email, label, disabled_at, created_at) VALUES
  ('provisioning-admin', 'service', NULL, NULL, 'provisioning', NULL, 1782561600)
  ON CONFLICT DO NOTHING;
