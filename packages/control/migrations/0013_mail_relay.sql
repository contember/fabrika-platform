-- The platform transport's mail relay. `platform_transport_keys`: the keys an application environment calls a platform
-- receiver with, as SHA-256 hashes; the value is sealed in the vault under
-- `platform:platform-key:<app>@<env>:<receiver>`. A rotated key keeps its row, and so stays valid, until its own expiry.
CREATE TABLE platform_transport_keys (
	app_id     TEXT NOT NULL,
	env        TEXT NOT NULL,
	receiver   TEXT NOT NULL,
	key_id     TEXT NOT NULL,
	key_hash   TEXT NOT NULL UNIQUE,
	value_ref  TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (app_id, env, receiver, key_id),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);

-- One message a sender handed the relay. `sender` is `<app>@<env>` or `installation:<service>`. The recipient, the
-- subject and the bodies live only in `content` (the canonical request body), which is purged once the row is final.
CREATE TABLE mail_messages (
	id                  TEXT PRIMARY KEY,
	sender              TEXT NOT NULL,
	idempotency_key     TEXT NOT NULL,
	fingerprint         TEXT NOT NULL,
	recipient_domain    TEXT NOT NULL,
	state               TEXT NOT NULL CHECK (state IN ('held', 'queued', 'sent', 'failed', 'unknown', 'dropped')),
	rule_id             TEXT,
	decided_by          TEXT,
	attempts            INTEGER NOT NULL,
	next_attempt_at     INTEGER,
	provider_message_id TEXT,
	error_code          TEXT,
	content             TEXT,
	created_at          INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL,
	UNIQUE (sender, idempotency_key)
);
CREATE INDEX idx_mail_messages_due ON mail_messages(state, next_attempt_at);

-- The gate: `scope` is `*` or `<app>@<env>`, `domain` is `*` or a lowercase recipient domain. The most specific rule
-- decides a message at acceptance; no rule passes it.
CREATE TABLE mail_rules (
	id         TEXT PRIMARY KEY,
	scope      TEXT NOT NULL,
	domain     TEXT NOT NULL,
	action     TEXT NOT NULL CHECK (action IN ('pass', 'hold', 'drop')),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (scope, domain)
);
