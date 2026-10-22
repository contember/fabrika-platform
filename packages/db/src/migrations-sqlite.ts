// @fabrika/db/migrations-sqlite — the framework's own tables in an application's SQLite database, a Cloudflare
// Durable Object's (ADR-0065). The same tables and columns as the Postgres bundle in `migrations.ts`, without the
// history a Postgres schema carries: no form files and no adoption of collection tables, which no SQLite database
// ever had. Plain data, applied as the bundle `fabrika` before the application's `app` bundle.
//
// The SQLite forms of the column types, which every framework statement and the row reads rely on:
// - a timestamp is TEXT in UTC, `YYYY-MM-DDTHH:MM:SS.sssZ`: what `strftime(SQLITE_NOW_FORMAT, 'now')` and
//   `Date#toISOString()` both write, so text order is time order;
// - a boolean is INTEGER 0 or 1; a UUID is TEXT; a BIGINT is INTEGER.

import {
	FILE_DELETIONS_TABLE,
	FILES_TABLE,
	FORM_ADMISSIONS_TABLE,
	FORM_BYTES_TABLE,
	FORM_CHALLENGES_TABLE,
	type FrameworkMigration,
	JOB_KICKS_TABLE,
	JOB_LEASES_TABLE,
	WEBHOOK_BINDINGS_TABLE,
	WEBHOOK_DELIVERIES_TABLE,
} from './migrations'

/** The `strftime` format of a stored timestamp; `strftime(SQLITE_NOW_FORMAT, 'now')` is the database's clock. */
export const SQLITE_NOW_FORMAT = '%Y-%m-%dT%H:%M:%fZ'

export const SQLITE_FRAMEWORK_MIGRATIONS: readonly FrameworkMigration[] = Object.freeze([
	Object.freeze({
		name: '0001_framework.sql',
		sql: `-- A binding admits deliveries for one scope value from one provider account, signed with its own secret.
CREATE TABLE ${WEBHOOK_BINDINGS_TABLE} (
	id TEXT PRIMARY KEY,
	webhook TEXT NOT NULL,
	scope_type TEXT NOT NULL,
	scope_value TEXT NOT NULL,
	account TEXT NOT NULL,
	secret TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
) STRICT;

-- GitHub signs no timestamp, so a recorded delivery id is the replay defence. A delivery is claimed with a lease and
-- completed in its handler's transaction, which clears the lease.
CREATE TABLE ${WEBHOOK_DELIVERIES_TABLE} (
	binding_id TEXT NOT NULL REFERENCES ${WEBHOOK_BINDINGS_TABLE} (id) ON DELETE CASCADE,
	delivery_id TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	lease_until INTEGER,
	PRIMARY KEY (binding_id, delivery_id)
) STRICT;

-- One row per job: the lease a run takes, fenced by its generation, and the outcome of the last run.
CREATE TABLE ${JOB_LEASES_TABLE} (
	job TEXT PRIMARY KEY,
	generation INTEGER NOT NULL,
	holder TEXT,
	expires_at TEXT NOT NULL,
	attempt_deadline TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_started_at TEXT,
	last_finished_at TEXT,
	last_status TEXT,
	last_succeeded_at TEXT,
	last_duration_ms INTEGER,
	last_missed_reported_at TEXT
) STRICT;

-- Whether a kick arrived after the job's current run started: that run runs the job once more after it succeeded.
CREATE TABLE ${JOB_KICKS_TABLE} (
	job TEXT PRIMARY KEY,
	pending INTEGER NOT NULL CHECK (pending IN (0, 1))
) STRICT;

-- A form's admission counters, one row per form, bucket and minute; a row of a past minute is pruned by the next
-- admission.
CREATE TABLE ${FORM_ADMISSIONS_TABLE} (
	form TEXT NOT NULL,
	bucket TEXT NOT NULL,
	window_start TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (form, bucket, window_start)
) STRICT;
CREATE INDEX ${FORM_ADMISSIONS_TABLE}_window_start ON ${FORM_ADMISSIONS_TABLE} (window_start);

-- The digest of each challenge token a form accepted, until the token could no longer verify: a replay is refused.
CREATE TABLE ${FORM_CHALLENGES_TABLE} (
	form TEXT NOT NULL,
	token_digest TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (form, token_digest)
) STRICT;
CREATE INDEX ${FORM_CHALLENGES_TABLE}_expires_at ON ${FORM_CHALLENGES_TABLE} (expires_at);

-- The bytes a form's files may write per hour: one row per form and hour, which the next reservation of a later hour
-- prunes.
CREATE TABLE ${FORM_BYTES_TABLE} (
	form TEXT NOT NULL,
	window_start TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	PRIMARY KEY (form, window_start)
) STRICT;

-- Every stored file: a value a table's file column references by id. A row is 'pending' from before its object
-- (<kind>/<id>) is written until the first reference claims it, then 'quarantined' (a scanning kind) or 'live'.
CREATE TABLE ${FILES_TABLE} (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	status TEXT NOT NULL CONSTRAINT ${FILES_TABLE}_status CHECK (status IN ('pending', 'quarantined', 'live', 'rejected')),
	object_key TEXT NOT NULL UNIQUE,
	size INTEGER,
	sha256 TEXT,
	content_type TEXT NOT NULL,
	name TEXT,
	scope TEXT,
	request TEXT,
	created_at TEXT NOT NULL,
	object_version TEXT,
	scan_attempts INTEGER NOT NULL DEFAULT 0,
	scan_after TEXT,
	legacy TEXT
) STRICT;
CREATE INDEX ${FILES_TABLE}_created_at ON ${FILES_TABLE} (created_at) WHERE legacy IS NULL;
CREATE INDEX ${FILES_TABLE}_scan ON ${FILES_TABLE} (scan_after) WHERE status = 'quarantined';

-- An object whose file row is deleted, until the object is: the sweep finishes a deletion a crash interrupted.
CREATE TABLE ${FILE_DELETIONS_TABLE} (
	object_key TEXT PRIMARY KEY,
	recorded_at TEXT NOT NULL
) STRICT;
`,
	}),
])
