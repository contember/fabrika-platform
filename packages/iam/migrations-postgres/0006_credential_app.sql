-- Bind every `px_` credential to the app it was issued for. Postgres twin of
-- ../migrations/0012_credential_app.sql — same outcome, same hard cutover.
--
-- An ANONYMOUS credential (a share link: `principal_id IS NULL`) carries FROZEN inline grants,
-- delegation-checked at issue against the issuer's permissions FOR ONE APP. Nothing recorded which
-- app, so authority granted per app was spendable installation-wide — including satisfying every
-- other app's `service` gate. See the SQLite twin's header for the full statement of the defect.
--
-- THIS IS A HARD CUTOVER. `app IS NULL` stops working for an anonymous credential: there is no
-- correct value to backfill and guessing would hand out the authority this bounds. Existing share
-- links must be REISSUED. The rows stay (revoking them would erase the record of what existed) and
-- simply stop resolving. A PRINCIPAL-BOUND credential may keep `app IS NULL` — it holds no frozen
-- authority, its permissions resolve per app through `grants`, so NULL there means "cross-app" and is
-- a choice rather than an omission.

ALTER TABLE credentials ADD COLUMN app TEXT;

CREATE INDEX idx_credentials_app ON credentials(app);

-- Name the links an operator has to reissue, at the moment they can still act on it. A NOTICE, not an
-- exception: nothing here is ambiguous and nothing needs a human decision before the schema is
-- correct — the credentials simply stop working, which is the safe direction.
DO $$
DECLARE stranded text;
BEGIN
	SELECT string_agg(id || ' (' || coalesce(label, 'no label') || ')', ', ' ORDER BY id) INTO stranded
	FROM credentials
	WHERE principal_id IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > extract(epoch FROM now()));
	IF stranded IS NOT NULL THEN
		RAISE NOTICE 'iam/0006: these share links are not bound to an app and will stop resolving until they are reissued: %', stranded;
	END IF;
END $$;
