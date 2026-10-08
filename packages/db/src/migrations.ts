// @fabrika/db/migrations — the framework's own tables in an application's schema (`fabrika_*`, ADR-0017). The
// migration runner applies them as the bundle `fabrika` before the application's `app` bundle; codegen leaves them
// out, so no store reaches them. Plain data, imported by the runner and by `@fabrika/db`'s framework side.

/** Migration identity of the framework's tables in every application schema: bundle `fabrika`, same ledger. */
export const FRAMEWORK_MIGRATION_BUNDLE = 'fabrika'

export const WEBHOOK_BINDINGS_TABLE = 'fabrika_webhook_bindings'
export const WEBHOOK_DELIVERIES_TABLE = 'fabrika_webhook_deliveries'

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
])
