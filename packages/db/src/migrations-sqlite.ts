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
	JOB_SCHEDULE_TABLE,
	JOB_WAKES_TABLE,
	LIST_CURSOR_KEY_TABLE,
	NOTIFICATIONS_TABLE,
	PUSH_SUBSCRIPTIONS_TABLE,
	REQUEST_RECEIPTS_TABLE,
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
	Object.freeze({
		name: '0002_job_wakes.sql',
		sql: `-- A job's pending work, one row per due unit: its next scheduled run, a kick, a claim's re-arm, a durable retry. due_at
-- is epoch milliseconds. Only the fenced finish of a run that started at or after a row changes it: consumed when the run is
-- done with it, or moved to a retry, which counts in attempt.
CREATE TABLE ${JOB_WAKES_TABLE} (
	id TEXT PRIMARY KEY,
	job TEXT NOT NULL,
	due_at INTEGER NOT NULL,
	reason TEXT NOT NULL CONSTRAINT ${JOB_WAKES_TABLE}_reason CHECK (reason IN ('cron', 'kick', 'claim', 'retry')),
	attempt INTEGER NOT NULL DEFAULT 0,
	dedupe TEXT
) STRICT;
CREATE INDEX ${JOB_WAKES_TABLE}_due ON ${JOB_WAKES_TABLE} (due_at);
CREATE UNIQUE INDEX ${JOB_WAKES_TABLE}_dedupe ON ${JOB_WAKES_TABLE} (dedupe) WHERE dedupe IS NOT NULL;
`,
	}),
	Object.freeze({
		name: '0003_file_deletions_recorded_at.sql',
		sql: `-- A queued key is a tombstone kept for the retention window: the sweep reads the due ones by age, not the whole queue.
CREATE INDEX ${FILE_DELETIONS_TABLE}_recorded_at ON ${FILE_DELETIONS_TABLE} (recorded_at, object_key);
`,
	}),
	Object.freeze({
		name: '0004_job_wakes_owned.sql',
		sql: `-- The wakes the run holding the job's lease took when it took the lease: its finish consumes or retries exactly these.
-- A wake written or merged into afterwards is not taken, though due before the run started: the run may not have read its work.
ALTER TABLE ${JOB_WAKES_TABLE} ADD COLUMN owned INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0, 1));
`,
	}),
	Object.freeze({
		name: '0005_request_receipts.sql',
		sql: `-- The answer of a mutation whose request carried a key (ADR-0078), for a repeat of that request: the principal's key,
-- the operation and the SHA-256 of its input, and the output's JSON. created_at is epoch milliseconds; each write prunes
-- a batch of receipts past the retention.
CREATE TABLE ${REQUEST_RECEIPTS_TABLE} (
	principal TEXT NOT NULL,
	request_key TEXT NOT NULL,
	operation TEXT NOT NULL,
	identity TEXT NOT NULL,
	output TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (principal, request_key)
) STRICT;
CREATE INDEX ${REQUEST_RECEIPTS_TABLE}_created_at ON ${REQUEST_RECEIPTS_TABLE} (created_at);
`,
	}),
	Object.freeze({
		name: '0006_list_cursor_key.sql',
		sql: `-- The key a list's cursor is signed with (list-cursor.ts), so a cursor a client edited is refused: one row, written
-- here once and only read afterwards. 32 random bytes as hex.
CREATE TABLE ${LIST_CURSOR_KEY_TABLE} (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	secret TEXT NOT NULL
) STRICT;
INSERT INTO ${LIST_CURSOR_KEY_TABLE} (id, secret) VALUES (1, hex(randomblob(32)));
`,
	}),
	Object.freeze({
		name: '0007_job_schedule.sql',
		sql: `-- Which deploy keeps the cron wakes where no crontab runs (ADR-0080): one row, the highest generation a serving process
-- has seen. The Durable Object keeps its schedule itself and never writes it; the table keeps both bundles alike.
CREATE TABLE ${JOB_SCHEDULE_TABLE} (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	generation TEXT NOT NULL
) STRICT;
`,
	}),
	Object.freeze({
		name: '0008_job_schedule_declared.sql',
		sql: `-- The cron keys the stored generation's deploy declares, as a JSON array (see the Postgres bundle's 0014).
ALTER TABLE ${JOB_SCHEDULE_TABLE} ADD COLUMN declared TEXT NOT NULL DEFAULT '[]';
`,
	}),
	Object.freeze({
		name: '0009_push_subscriptions.sql',
		sql: `-- A browser's Web Push subscription (ADR-0088), bound to the principal who recorded it; a row whose gone_at is set is a
-- tombstone (see the Postgres bundle's 0015). Times are epoch milliseconds.
CREATE TABLE ${PUSH_SUBSCRIPTIONS_TABLE} (
	id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	endpoint TEXT NOT NULL UNIQUE,
	p256dh TEXT,
	auth TEXT,
	vapid_key TEXT,
	cursor TEXT,
	next_attempt_at INTEGER,
	recorded_at INTEGER NOT NULL,
	gone_at INTEGER,
	CONSTRAINT ${PUSH_SUBSCRIPTIONS_TABLE}_tombstone CHECK (
		(gone_at IS NULL AND p256dh IS NOT NULL AND auth IS NOT NULL AND vapid_key IS NOT NULL)
		OR (gone_at IS NOT NULL AND p256dh IS NULL AND auth IS NULL AND vapid_key IS NULL AND next_attempt_at IS NULL)
	)
) STRICT;
CREATE INDEX ${PUSH_SUBSCRIPTIONS_TABLE}_principal ON ${PUSH_SUBSCRIPTIONS_TABLE} (principal, recorded_at) WHERE gone_at IS NULL;
CREATE INDEX ${PUSH_SUBSCRIPTIONS_TABLE}_gone_at ON ${PUSH_SUBSCRIPTIONS_TABLE} (gone_at) WHERE gone_at IS NOT NULL;
`,
	}),
	Object.freeze({
		name: '0010_notifications.sql',
		sql: `-- A notification for one principal (ADR-0088 §6); see the Postgres bundle's 0016. The id is a UUIDv7 as lowercase
-- text, so text order is the order written.
CREATE TABLE ${NOTIFICATIONS_TABLE} (
	id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	path TEXT NOT NULL,
	action TEXT NOT NULL,
	dimension TEXT,
	scope_value TEXT,
	created_at INTEGER NOT NULL,
	CONSTRAINT ${NOTIFICATIONS_TABLE}_about CHECK ((dimension IS NULL) = (scope_value IS NULL))
) STRICT;
CREATE INDEX ${NOTIFICATIONS_TABLE}_principal ON ${NOTIFICATIONS_TABLE} (principal, id);
CREATE INDEX ${NOTIFICATIONS_TABLE}_created_at ON ${NOTIFICATIONS_TABLE} (created_at);
`,
	}),
])
