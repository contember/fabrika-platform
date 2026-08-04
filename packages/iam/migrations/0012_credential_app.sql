-- Bind every `px_` credential to the app it was issued for. Twin of
-- ../migrations-postgres/0006_credential_app.sql — the OUTCOME of the two files must match.
--
-- An ANONYMOUS credential (a share link: `principal_id IS NULL`) carries FROZEN inline grants. Those
-- grants were delegation-checked at issue time against the issuer's permissions FOR ONE APP — but
-- nothing recorded which app, and `resolveCredential` ignored the app it was asked about on that
-- branch. So authority was granted per app and spent installation-wide: an app-scoped admin of the
-- least important app could issue `{ action: '*' }` and present the key to every other app behind the
-- proxy. Even without a privileged grant, any valid anonymous credential satisfied every app's
-- `service` gate, and `examples/app/fabrika.gates.ts` ships `{ path: '/*', kind: 'service' }`.
--
-- THIS IS A HARD CUTOVER. `app IS NULL` stops working for an anonymous credential — there is no
-- correct value to backfill, because the app a share link was meant for is not recorded anywhere and
-- guessing it would hand out exactly the authority this migration exists to bound. Every existing
-- share link must be REISSUED; the rows are left in place (revoking them here would erase the record
-- of what existed) and simply stop resolving, which is the fail-closed direction.
--
-- A PRINCIPAL-BOUND credential may keep `app IS NULL`, and existing ones do. It carries no frozen
-- authority: its permissions are resolved per app from `grants`, which are themselves app-filtered,
-- so a NULL there means "cross-app" and is a real, safe choice an operator can make. When it names an
-- app, that is a downscope and is enforced the same way.
--
-- The query that lists the links an operator has to reissue:
--
--   SELECT id, label, issued_by, created_at FROM credentials
--   WHERE principal_id IS NULL AND app IS NULL AND revoked_at IS NULL
--     AND (expires_at IS NULL OR expires_at > strftime('%s','now'));

ALTER TABLE credentials ADD COLUMN app TEXT;

-- Every lookup is by hash first, so this index exists for the admin share-links page, which lists one
-- app's links a page at a time.
CREATE INDEX idx_credentials_app ON credentials(app);
