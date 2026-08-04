-- One mailbox rule: `principals.email` becomes the NORMALIZED mailbox, and every user principal
-- carries its reservation in `principal_email_claims`. Twin of
-- ../migrations-postgres/0005_one_mailbox_rule.sql — the OUTCOME of the two files must match.
--
-- Until now email identity forked. The password path compared case-insensitively while the OIDC path
-- compared `email = ?` verbatim, and `idx_principals_uq_email` is case-SENSITIVE on both engines, so
-- an invite for `Bob@Example.com` and an IdP that answers `bob@example.com` produced TWO principals
-- for one human: the invite and every grant on it went dead, and password sign-in became permanently
-- ambiguous. After this migration `email` holds exactly one spelling of a mailbox, comparison is
-- plain equality, and no query asks the engine to case-fold.
--
-- THIS MIGRATION REFUSES TO GUESS. Two classes of row stop it dead so an operator resolves them by
-- hand; nothing is merged automatically, because merging picks which identity's grants survive.
-- Both guards abort through a trigger, because RAISE() is only legal in a trigger body in SQLite,
-- and their messages are static for the same reason — the two queries that list the offending rows
-- are here instead:
--
--   -- 1. mailboxes this file cannot fold identically on both engines
--   SELECT id, email FROM principals
--   WHERE type = 'user' AND email IS NOT NULL
--     AND length(email) <> length(CAST(email AS BLOB))
--     AND email <> LOWER(TRIM(email));
--
--   -- 2. principals that become one mailbox
--   SELECT LOWER(TRIM(email)) AS mailbox, COUNT(*) AS principals,
--          group_concat(id) AS principal_ids, group_concat(email) AS spellings
--   FROM principals
--   WHERE type = 'user' AND email IS NOT NULL
--   GROUP BY LOWER(TRIM(email))
--   HAVING COUNT(*) > 1;

CREATE TABLE iam_0011_guard (reason TEXT);

-- Guard 1. SQLite's LOWER() folds ASCII only, so a legacy `JOSE@x.cz` spelled with an accent would
-- be stored one way here and another on Postgres, and the two backends would disagree about who that
-- is. A mailbox already in lower case passes untouched, whatever alphabet it uses.
CREATE TRIGGER iam_0011_guard_unfoldable BEFORE INSERT ON iam_0011_guard WHEN NEW.reason = 'unfoldable'
BEGIN
	SELECT RAISE(
		ABORT,
		'iam/0011 refused: a user mailbox holds non-ASCII characters and is not stored in lower case, so SQLite and Postgres would normalize it differently. Rewrite each one to its canonical NFC lower-case form and re-run. The query that lists them is in the header of migrations/0011_one_mailbox_rule.sql.'
	);
END;

INSERT INTO iam_0011_guard (reason)
	SELECT 'unfoldable' FROM principals
	WHERE type = 'user' AND email IS NOT NULL
		AND length(email) <> length(CAST(email AS BLOB))
		AND email <> LOWER(TRIM(email))
	LIMIT 1;

-- Guard 2. Two principals that become one mailbox — the bug itself, sitting in the data.
CREATE TRIGGER iam_0011_guard_collision BEFORE INSERT ON iam_0011_guard WHEN NEW.reason = 'collision'
BEGIN
	SELECT RAISE(
		ABORT,
		'iam/0011 refused: two or more user principals share one mailbox once case is normalized. Decide which principal keeps the address, move its grants onto that one, then delete or re-address the others and re-run. The query that lists them is in the header of migrations/0011_one_mailbox_rule.sql.'
	);
END;

INSERT INTO iam_0011_guard (reason)
	SELECT 'collision' FROM principals
	WHERE type = 'user' AND email IS NOT NULL
	GROUP BY LOWER(TRIM(email))
	HAVING COUNT(*) > 1
	LIMIT 1;

DROP TRIGGER iam_0011_guard_unfoldable;
DROP TRIGGER iam_0011_guard_collision;
DROP TABLE iam_0011_guard;

-- The spelling survives in `label`; only the identity column is rewritten.
UPDATE principals
	SET email = LOWER(TRIM(email))
	WHERE type = 'user' AND email IS NOT NULL AND email <> LOWER(TRIM(email));

-- 0009 deliberately left legacy rows out of the reservation table, because a collision could not be
-- resolved then. It can now — the guards above proved there is none — so every user principal that
-- carries a mailbox carries a claim for it, and the table finally means what its name says.
INSERT INTO principal_email_claims (normalized_email, principal_id)
	SELECT p.email, p.id FROM principals p
	WHERE p.type = 'user' AND p.email IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM principal_email_claims c WHERE c.principal_id = p.id);
