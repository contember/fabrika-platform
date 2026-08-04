-- One mailbox rule: `principals.email` becomes the NORMALIZED mailbox, and every user principal
-- carries its reservation in `principal_email_claims`. This is the Postgres twin of
-- ../migrations/0011_one_mailbox_rule.sql — same guards, same outcome, same refusals.
--
-- Until now email identity forked. The password path compared case-insensitively while the OIDC path
-- compared `email = ?` verbatim, and `idx_principals_uq_email` is case-SENSITIVE on both engines, so
-- an invite for `Bob@Example.com` and an IdP that answers `bob@example.com` produced TWO principals
-- for one human. After this migration `email` holds exactly one spelling of a mailbox, comparison is
-- plain equality, and no query asks the engine to case-fold.
--
-- THIS MIGRATION REFUSES TO GUESS. Nothing is merged automatically, because merging picks which
-- identity's grants survive. Postgres can name the offending rows in the error, so it does; the
-- SQLite twin can only point at the queries (RAISE takes a literal there).

-- Guard 1: a mailbox this file cannot fold the way the application does. Postgres LOWER() is
-- Unicode-aware and SQLite's is ASCII-only, so a legacy `JOSE@x.cz` spelled with an accent would end
-- up different on the two backends. Refuse on BOTH, so one installation's data migrates one way.
DO $$
DECLARE offenders text;
BEGIN
	SELECT string_agg(id || ' <' || email || '>', ', ' ORDER BY id) INTO offenders
	FROM principals
	WHERE type = 'user' AND email IS NOT NULL
		AND length(email) <> octet_length(email)
		AND email <> lower(btrim(email));
	IF offenders IS NOT NULL THEN
		RAISE EXCEPTION 'iam/0005 refused: these user mailboxes hold non-ASCII characters and are not stored in lower case, so SQLite and Postgres would normalize them differently: %. Rewrite each one to its canonical NFC lower-case form and re-run.', offenders;
	END IF;
END $$;

-- Guard 2: two principals that become one mailbox — the bug itself, sitting in the data.
DO $$
DECLARE collisions text;
BEGIN
	SELECT string_agg(entry, '; ' ORDER BY entry) INTO collisions
	FROM (
		SELECT lower(btrim(email)) || ' -> ' || string_agg(id || ' <' || email || '>', ', ' ORDER BY id) AS entry
		FROM principals
		WHERE type = 'user' AND email IS NOT NULL
		GROUP BY lower(btrim(email))
		HAVING count(*) > 1
	) AS grouped;
	IF collisions IS NOT NULL THEN
		RAISE EXCEPTION 'iam/0005 refused: these user principals share one mailbox once case is normalized: %. Decide which principal keeps the address, move its grants onto that one, then delete or re-address the others and re-run.', collisions;
	END IF;
END $$;

-- The spelling survives in `label`; only the identity column is rewritten.
UPDATE principals
	SET email = lower(btrim(email))
	WHERE type = 'user' AND email IS NOT NULL AND email <> lower(btrim(email));

-- 0003 deliberately left legacy rows out of the reservation table, because a collision could not be
-- resolved then. It can now — the guards above proved there is none — so every user principal that
-- carries a mailbox carries a claim for it, and the table finally means what its name says.
INSERT INTO principal_email_claims (normalized_email, principal_id)
	SELECT p.email, p.id FROM principals p
	WHERE p.type = 'user' AND p.email IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM principal_email_claims c WHERE c.principal_id = p.id);
