// @fabrika/db/migrations — the framework's own tables in an application's schema (`fabrika_*`, ADR-0017). The
// migration runner applies them as the bundle `fabrika` before the application's `app` bundle; codegen leaves them
// out, so no store reaches them. Plain data, imported by the runner and by `@fabrika/db`'s framework side.

/** Migration identity of the framework's tables in every application schema: bundle `fabrika`, same ledger. */
export const FRAMEWORK_MIGRATION_BUNDLE = 'fabrika'

export const WEBHOOK_BINDINGS_TABLE = 'fabrika_webhook_bindings'
export const WEBHOOK_DELIVERIES_TABLE = 'fabrika_webhook_deliveries'
export const JOB_LEASES_TABLE = 'fabrika_job_leases'
export const JOB_KICKS_TABLE = 'fabrika_job_kicks'
export const JOB_WAKES_TABLE = 'fabrika_wakes'
export const FORM_ADMISSIONS_TABLE = 'fabrika_form_admissions'
export const FORM_CHALLENGES_TABLE = 'fabrika_form_challenges'
export const FORM_FILES_TABLE = 'fabrika_form_files'
export const FORM_BYTES_TABLE = 'fabrika_form_bytes'
export const FILES_TABLE = 'fabrika_files'
export const FILE_DELETIONS_TABLE = 'fabrika_file_deletions'
/** The function an application's last adoption migration calls with the name of a file collection it adopted. */
export const FILES_RELEASE_FUNCTION = 'fabrika_files_release'
/**
 * The function an adoption migration calls right before it reads a collection's table: it copies the rows an older
 * instance wrote since 0008 ran, so each one it adopts has its `fabrika_files` row. Idempotent.
 */
export const FILES_COPY_FUNCTION = 'fabrika_files_copy_legacy'

export interface FrameworkMigration {
	/** Ordered by name; an applied one is immutable, like an application's. */
	readonly name: string
	readonly sql: string
}

export const FRAMEWORK_MIGRATIONS: readonly FrameworkMigration[] = Object.freeze([
	Object.freeze({
		name: '0001_webhooks.sql',
		sql: `-- A binding admits deliveries for one scope value from one provider account, signed with its own secret.
CREATE TABLE ${WEBHOOK_BINDINGS_TABLE} (
	id TEXT PRIMARY KEY,
	webhook TEXT NOT NULL,
	scope_type TEXT NOT NULL,
	scope_value TEXT NOT NULL,
	account TEXT NOT NULL,
	secret TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at BIGINT NOT NULL
);

-- GitHub signs no timestamp, so a recorded delivery id is the replay defence.
CREATE TABLE ${WEBHOOK_DELIVERIES_TABLE} (
	binding_id TEXT NOT NULL REFERENCES ${WEBHOOK_BINDINGS_TABLE} (id) ON DELETE CASCADE,
	delivery_id TEXT NOT NULL,
	received_at BIGINT NOT NULL,
	PRIMARY KEY (binding_id, delivery_id)
);
`,
	}),
	Object.freeze({
		name: '0002_job_leases.sql',
		sql: `-- One row per job: the lease a run takes, fenced by its generation, and the outcome of the last run.
CREATE TABLE ${JOB_LEASES_TABLE} (
	job TEXT PRIMARY KEY,
	generation INTEGER NOT NULL,
	holder TEXT,
	expires_at TIMESTAMPTZ NOT NULL,
	attempt_deadline TIMESTAMPTZ NOT NULL,
	first_seen_at TIMESTAMPTZ NOT NULL,
	last_started_at TIMESTAMPTZ,
	last_finished_at TIMESTAMPTZ,
	last_status TEXT,
	last_succeeded_at TIMESTAMPTZ,
	last_duration_ms INTEGER,
	last_missed_reported_at TIMESTAMPTZ
);
`,
	}),
	Object.freeze({
		name: '0003_form_admissions.sql',
		sql: `-- A form's admission counters, one row per form, bucket (a client's digest, or the form's accepted submissions) and
-- minute; a row of a past minute is expired and pruned by the next admission.
CREATE TABLE ${FORM_ADMISSIONS_TABLE} (
	form TEXT NOT NULL,
	bucket TEXT NOT NULL,
	window_start TIMESTAMPTZ NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (form, bucket, window_start)
);
CREATE INDEX ${FORM_ADMISSIONS_TABLE}_window_start ON ${FORM_ADMISSIONS_TABLE} (window_start);

-- The digest of each challenge token a form accepted, until the token could no longer verify: a replay is refused.
CREATE TABLE ${FORM_CHALLENGES_TABLE} (
	form TEXT NOT NULL,
	token_digest TEXT NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (form, token_digest)
);
CREATE INDEX ${FORM_CHALLENGES_TABLE}_expires_at ON ${FORM_CHALLENGES_TABLE} (expires_at);
`,
	}),
	Object.freeze({
		name: '0004_job_kicks.sql',
		sql: `-- Whether a kick arrived after the job's current run started: that run runs the job once more after it succeeded.
-- Apart from the lease row, so a kick never waits on the fence a running attempt holds there.
CREATE TABLE ${JOB_KICKS_TABLE} (
	job TEXT PRIMARY KEY,
	pending BOOLEAN NOT NULL
);
`,
	}),
	Object.freeze({
		name: '0005_form_files.sql',
		sql: `-- A file a form received with a submission, owned by nobody and served by no endpoint. It is 'pending' from before
-- its object (<collection>/<id>) is written until the submission's inbox row commits, then 'held' until held_until:
-- the job that drains the inbox attaches it to its owner, which moves it into the collection's own table, or the
-- sweep deletes its object and the row once the hold ended (a pending row once it is an hour old).
CREATE TABLE ${FORM_FILES_TABLE} (
	id UUID PRIMARY KEY,
	form TEXT NOT NULL,
	collection TEXT NOT NULL,
	status TEXT NOT NULL CONSTRAINT ${FORM_FILES_TABLE}_status CHECK (status IN ('pending', 'held')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	sha256 TEXT,
	content_type TEXT NOT NULL,
	original_name TEXT,
	created_at TIMESTAMPTZ NOT NULL,
	held_until TIMESTAMPTZ
);
CREATE INDEX ${FORM_FILES_TABLE}_created_at ON ${FORM_FILES_TABLE} (created_at);
`,
	}),
	Object.freeze({
		name: '0006_form_bytes.sql',
		sql: `-- The bytes a form's files may write per hour, shared by every instance: one row per form and hour, which the next
-- reservation of a later hour prunes. A file reserves its collection's maxBytes before its object is written.
CREATE TABLE ${FORM_BYTES_TABLE} (
	form TEXT NOT NULL,
	window_start TIMESTAMPTZ NOT NULL,
	bytes BIGINT NOT NULL,
	PRIMARY KEY (form, window_start)
);
`,
	}),
	Object.freeze({
		name: '0007_webhook_delivery_claims.sql',
		sql: `-- A delivery is claimed with a lease and completed in its handler's transaction, which clears the lease. A claim
-- whose lease expired without completion is taken over by the provider's redelivery. Every row recorded before has
-- no lease, so it stays a completed delivery, as does one an older framework release records during a rollout.
ALTER TABLE ${WEBHOOK_DELIVERIES_TABLE} ADD COLUMN lease_until BIGINT;
`,
	}),
	Object.freeze({
		name: '0008_files.sql',
		sql: `-- Every stored file: a value a table's file column references by id. A row is 'pending' from before its object
-- (<kind>/<id>) is written until the first reference claims it, then 'quarantined' (a scanning kind) or 'live'; the scan
-- makes a quarantined one 'live' or 'rejected'. scope is the top-level value of its first dimensional reference; legacy
-- names the collection a migrated file came from, which the sweep never deletes.
CREATE TABLE ${FILES_TABLE} (
	id UUID PRIMARY KEY,
	kind TEXT NOT NULL,
	status TEXT NOT NULL CONSTRAINT ${FILES_TABLE}_status CHECK (status IN ('pending', 'quarantined', 'live', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	sha256 TEXT,
	content_type TEXT NOT NULL,
	name TEXT,
	scope TEXT,
	request TEXT,
	created_at TIMESTAMPTZ NOT NULL,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TIMESTAMPTZ,
	legacy TEXT
);
CREATE INDEX ${FILES_TABLE}_created_at ON ${FILES_TABLE} (created_at) WHERE legacy IS NULL;
CREATE INDEX ${FILES_TABLE}_scan ON ${FILES_TABLE} (scan_after) WHERE status = 'quarantined';
CREATE INDEX ${FILES_TABLE}_legacy ON ${FILES_TABLE} (legacy) WHERE legacy IS NOT NULL;

-- An object whose file row is deleted, until the object is: the sweep finishes a deletion a crash interrupted.
CREATE TABLE ${FILE_DELETIONS_TABLE} (
	object_key TEXT PRIMARY KEY,
	recorded_at TIMESTAMPTZ NOT NULL
);

-- Copies the held rows of a collection's table (fabrika_files_<collection>) into ${FILES_TABLE}, marked legacy with
-- the collection: same id, object, status and scan state. A row copied before is skipped, and so is an orphan, whose
-- owner was deleted: no application can adopt it, so the release records its object for deletion.
CREATE FUNCTION ${FILES_COPY_FUNCTION}(collection TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	source TEXT := 'fabrika_files_' || collection;
	scanned BOOLEAN;
BEGIN
	IF collection !~ '^[a-z_][a-z0-9_]*$' OR to_regclass(source) IS NULL THEN
		RAISE EXCEPTION 'no file collection table %', source;
	END IF;
	SELECT count(*) = 3 INTO scanned FROM information_schema.columns
	WHERE table_schema = current_schema() AND table_name = source AND column_name IN ('object_version', 'scan_attempts', 'scan_after');
	EXECUTE format(
		'INSERT INTO ${FILES_TABLE} (id, kind, status, object_key, size, sha256, content_type, name, created_at, object_version, scan_attempts, scan_after, legacy) '
		|| 'SELECT id, $1, status, object_key, size, sha256, content_type, original_name, created_at, %s, $1 FROM %I '
		|| 'WHERE deleted_at IS NULL AND status <> ''pending'' AND owner_id IS NOT NULL ON CONFLICT (id) DO NOTHING',
		CASE WHEN scanned THEN 'object_version, scan_attempts, scan_after' ELSE 'NULL, 0, NULL' END,
		source
	) USING collection;
END
$$;

-- An application's last adoption migration of a collection: it copies what an older version wrote meanwhile, refuses
-- while a copied file is referenced by no file column, clears the marker of the rest (the sweep may then delete one),
-- records the objects only the old table knew for deletion, and drops the old table.
CREATE FUNCTION ${FILES_RELEASE_FUNCTION}(collection TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	source TEXT := 'fabrika_files_' || collection;
	reference RECORD;
	referenced TEXT := 'false';
	unreferenced BIGINT;
BEGIN
	PERFORM ${FILES_COPY_FUNCTION}(collection);
	FOR reference IN
		SELECT c.conrelid::regclass::text AS relation, a.attname AS column_name
		FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
		WHERE c.contype = 'f' AND c.confrelid = '${FILES_TABLE}'::regclass AND cardinality(c.conkey) = 1
	LOOP
		referenced := referenced || format(' OR EXISTS (SELECT 1 FROM %s r WHERE r.%I = f.id)', reference.relation, reference.column_name);
	END LOOP;
	EXECUTE format('SELECT count(*) FROM ${FILES_TABLE} f WHERE f.legacy = $1 AND NOT (%s)', referenced) INTO unreferenced USING collection;
	IF unreferenced > 0 THEN
		RAISE EXCEPTION '${FILES_RELEASE_FUNCTION}(%): % files of the collection are referenced by no file column; adopt them in a migration first', collection, unreferenced;
	END IF;
	UPDATE ${FILES_TABLE} SET legacy = NULL WHERE legacy = collection;
	EXECUTE format(
		'INSERT INTO ${FILE_DELETIONS_TABLE} (object_key, recorded_at) SELECT s.object_key, now() FROM %I s '
		|| 'WHERE NOT EXISTS (SELECT 1 FROM ${FILES_TABLE} f WHERE f.object_key = s.object_key) ON CONFLICT (object_key) DO NOTHING',
		source
	);
	EXECUTE format('DROP TABLE %I', source);
END
$$;

-- Every collection table this schema holds now. A held form file moves too: its kind is its collection, and the grace
-- counts from the end of its hold, so the sweep keeps it as long as the hold did.
DO $$
DECLARE
	found RECORD;
BEGIN
	FOR found IN
		SELECT substr(table_name, length('fabrika_files_') + 1) AS name FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name LIKE 'fabrika\\_files\\_%'
	LOOP
		PERFORM ${FILES_COPY_FUNCTION}(found.name);
	END LOOP;
	INSERT INTO ${FILES_TABLE} (id, kind, status, object_key, size, sha256, content_type, name, created_at)
	SELECT f.id, f.collection, 'quarantined', f.object_key, f.size, f.sha256, f.content_type, f.original_name, f.held_until
	FROM ${FORM_FILES_TABLE} f WHERE f.status = 'held'
	ON CONFLICT (id) DO NOTHING;
	DELETE FROM ${FORM_FILES_TABLE} f WHERE status = 'held' AND EXISTS (SELECT 1 FROM ${FILES_TABLE} c WHERE c.id = f.id);
END
$$;
`,
	}),
	Object.freeze({
		name: '0009_job_wakes.sql',
		sql: `-- A job's pending work, one row per due unit: its next scheduled run, a kick, a claim's re-arm, a durable retry. due_at
-- is epoch milliseconds. Only the fenced finish of a run that started at or after a row changes it: consumed when the run is
-- done with it, or moved to a retry, which counts in attempt.
CREATE TABLE ${JOB_WAKES_TABLE} (
	id UUID PRIMARY KEY,
	job TEXT NOT NULL,
	due_at BIGINT NOT NULL,
	reason TEXT NOT NULL CONSTRAINT ${JOB_WAKES_TABLE}_reason CHECK (reason IN ('cron', 'kick', 'claim', 'retry')),
	attempt INTEGER NOT NULL DEFAULT 0,
	dedupe TEXT
);
CREATE INDEX ${JOB_WAKES_TABLE}_due ON ${JOB_WAKES_TABLE} (due_at);
CREATE UNIQUE INDEX ${JOB_WAKES_TABLE}_dedupe ON ${JOB_WAKES_TABLE} (dedupe) WHERE dedupe IS NOT NULL;
`,
	}),
	Object.freeze({
		name: '0010_job_wakes_owned.sql',
		sql: `-- The wakes the run holding the job's lease took when it took the lease: its finish consumes or retries exactly these.
-- A wake written or merged into afterwards is not taken, though due before the run started: the run may not have read its work.
ALTER TABLE ${JOB_WAKES_TABLE} ADD COLUMN owned BOOLEAN NOT NULL DEFAULT false;
`,
	}),
])
