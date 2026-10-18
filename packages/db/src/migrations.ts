// @fabrika/db/migrations — the framework's own tables in an application's schema (`fabrika_*`, ADR-0017). The
// migration runner applies them as the bundle `fabrika` before the application's `app` bundle; codegen leaves them
// out, so no store reaches them. Plain data, imported by the runner and by `@fabrika/db`'s framework side.

/** Migration identity of the framework's tables in every application schema: bundle `fabrika`, same ledger. */
export const FRAMEWORK_MIGRATION_BUNDLE = 'fabrika'

export const WEBHOOK_BINDINGS_TABLE = 'fabrika_webhook_bindings'
export const WEBHOOK_DELIVERIES_TABLE = 'fabrika_webhook_deliveries'
export const JOB_LEASES_TABLE = 'fabrika_job_leases'
export const JOB_KICKS_TABLE = 'fabrika_job_kicks'
export const FORM_ADMISSIONS_TABLE = 'fabrika_form_admissions'
export const FORM_CHALLENGES_TABLE = 'fabrika_form_challenges'
export const FORM_FILES_TABLE = 'fabrika_form_files'

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
])
