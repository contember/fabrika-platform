import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { allMigrations } from './helpers/migrations'

// Apply the real migrations to an in-memory SQLite and assert the schema contract
// the Worker relies on: the table set, the partial unique indexes (the NULL-in-UNIQUE
// traps), the role/inline XOR + both-or-neither scope CHECKs, and the fact that the
// JSON-bearing columns are plain TEXT (validity is enforced at the code ends, not by
// a dialect-specific CHECK).

const migration = allMigrations()

// `created_at` has no DDL default — `unixepoch()` is SQLite-only, so the writer always binds it
// (see the header of migrations/0001_init.sql). Every raw INSERT below therefore supplies one;
// the value itself is irrelevant to what these tests assert.
const T = 1_782_896_400

function freshDb(): Database {
	const db = new Database(':memory:')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec(migration)
	return db
}

/** Seed the principal the grant/credential tests hang off. */
function seedP1(db: Database, externalId: string | null = 'sub1', email = 'a@x.cz'): void {
	db.run(
		`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at)
		 VALUES ('p1', 'user', ${externalId === null ? 'NULL' : `'${externalId}'`}, '${email}', '${email}', ${externalId === null ? 'NULL' : T}, ${T})`,
	)
}

test('creates every table the worker reads/writes (and retires projects)', () => {
	const db = freshDb()
	const rows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()
	const names = rows.map((r) => r.name)
	for (
		const t of [
			'principals',
			'app_scopes',
			'app_actions',
			'roles',
			'grants',
			'audit_events',
			'auth_log',
			'credentials',
			'credential_grants',
			'sessions',
			'principal_email_claims',
			'password_accounts',
			'password_credentials',
			'password_action_tokens',
			'password_login_throttles',
		]
	) {
		expect(names).toContain(t)
	}
	// `projects` is gone — scope values are app-owned now, not a Propustka table.
	expect(names).not.toContain('projects')
	// `capability_tokens` is folded into `credentials` (0006).
	expect(names).not.toContain('capability_tokens')
	expect(names).not.toContain('capability_grants')
	// `group_role_mappings` is dropped (0007) — no IdP groups in native auth.
	expect(names).not.toContain('group_role_mappings')
})

test('created_at carries no DDL default — an INSERT that omits it is rejected', () => {
	// The portability contract in one assertion: the migrations no longer stamp `created_at` with
	// SQLite's `unixepoch()`, so a writer that forgets to bind it fails LOUDLY here (rather than
	// silently on Postgres, where the same DDL default cannot exist at all).
	const db = freshDb()
	expect(() => db.run("INSERT INTO principals (id, type, external_id, email, label) VALUES ('p0', 'user', 's0', 'a@x.cz', 'a@x.cz')"))
		.toThrow()
})

test('password migration backfills activation and enforces session authentication shape', () => {
	const db = freshDb()
	const provisioning = db.query<{ activated_at: number | null }, []>("SELECT activated_at FROM principals WHERE id = 'provisioning-admin'").get()
	expect(provisioning?.activated_at).not.toBeNull()

	seedP1(db)
	expect(() =>
		db.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at)
			VALUES ('s-invalid', 'h-invalid', 'p1', NULL, 'oidc', ${T}, ${T + 100})`)
	).toThrow()
	expect(() =>
		db.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at)
			VALUES ('s-password', 'h-password', 'p1', NULL, 'password', ${T}, ${T + 100})`)
	).not.toThrow()
	expect(() =>
		db.run(`INSERT INTO sessions (id, token_hash, principal_id, idp_sub, authentication_method, created_at, expires_at)
			VALUES ('s-password-invalid', 'h-password-invalid', 'p1', 'idp-sub', 'password', ${T}, ${T + 100})`)
	).toThrow()
})

test('password capability state is explicit and constrained', () => {
	const db = freshDb()
	seedP1(db)
	expect(() => db.run(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at) VALUES ('p1', 'pending', ${T}, ${T})`)).not
		.toThrow()
	db.run("DELETE FROM password_accounts WHERE principal_id = 'p1'")
	expect(() => db.run(`INSERT INTO password_accounts (principal_id, state, created_at, updated_at) VALUES ('p1', 'unknown', ${T}, ${T})`)).toThrow()
})

test('roles.permissions is plain TEXT — JSON validity is not a DB constraint', () => {
	// `json_valid()` is SQLite-only (Postgres has no equivalent in the common subset), so the
	// CHECK is gone and the DB accepts junk. The guarantee moved to the two ends instead: the
	// only writer JSON-encodes, and every reader goes through `parseJsonOrNull` (src/json.ts)
	// — see the fail-closed assertions in resolve.test.ts and admin-router.test.ts.
	const db = freshDb()
	expect(() =>
		db.run(`INSERT INTO roles (app, role_key, name, permissions, origin, created_at) VALUES ('opice', 'editor', 'Editor', 'not json', 'app', ${T})`)
	).not.toThrow()
	// origin, by contrast, IS constrained — `CHECK (x IN (...))` is portable, so it stays.
	expect(() =>
		db.run(`INSERT INTO roles (app, role_key, name, permissions, origin, created_at) VALUES ('opice', 'viewer', 'Viewer', '[]', 'bogus', ${T})`)
	).toThrow()
})

test('audit_events.diff is plain TEXT — JSON validity is not a DB constraint', () => {
	const db = freshDb()
	const insert = (id: string, diff: string) =>
		db.run(
			`INSERT INTO audit_events (id, request_id, principal_label, app, action, resource_type, diff, created_at)
			 VALUES ('${id}', 'r1', 'a@x.cz', 'app', 'x.update', 'x', ${diff}, ${T})`,
		)
	expect(() => insert('a1', "'not json'")).not.toThrow()
	expect(() => insert('a2', `'{"field":["old","new"]}'`)).not.toThrow()
})

test('a grant must carry EITHER a role_key OR inline permissions — never both, never neither', () => {
	const db = freshDb()
	seedP1(db)
	// Both set — rejected.
	expect(() =>
		db.run(`INSERT INTO grants (id, principal_id, role_key, permissions, created_at) VALUES ('gb', 'p1', 'editor', '["project.read"]', ${T})`)
	).toThrow()
	// Neither set — rejected.
	expect(() => db.run(`INSERT INTO grants (id, principal_id, role_key, permissions, created_at) VALUES ('gn', 'p1', NULL, NULL, ${T})`)).toThrow()
	// Role-only — ok.
	expect(() => db.run(`INSERT INTO grants (id, principal_id, role_key, created_at) VALUES ('gr', 'p1', 'editor', ${T})`)).not.toThrow()
	// Inline-only — ok.
	expect(() => db.run(`INSERT INTO grants (id, principal_id, permissions, created_at) VALUES ('gi', 'p1', '["report.export"]', ${T})`)).not.toThrow()
})

test('grant scope is both-or-neither (scope_type and scope_value rise/fall together)', () => {
	const db = freshDb()
	seedP1(db)
	// Half-set scopes are rejected.
	expect(() =>
		db.run(`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g1', 'p1', 'editor', 'team', NULL, ${T})`)
	).toThrow()
	expect(() =>
		db.run(`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g2', 'p1', 'editor', NULL, 'acme', ${T})`)
	).toThrow()
	// Both set, or both NULL (global) — ok.
	expect(() =>
		db.run(`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g3', 'p1', 'editor', 'team', 'acme', ${T})`)
	).not.toThrow()
})

test('partial unique index forbids a second GLOBAL role grant for the same (principal, role)', () => {
	const db = freshDb()
	seedP1(db)
	db.run(`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g1', 'p1', 'editor', NULL, NULL, ${T})`)
	// Second global role grant with the same (principal, role) — rejected despite NULL scope.
	expect(() =>
		db.run(`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g2', 'p1', 'editor', NULL, NULL, ${T})`)
	).toThrow()
})

test('two scoped role grants for the same (principal, role) on DIFFERENT scope values are allowed', () => {
	const db = freshDb()
	seedP1(db)
	db.run(
		`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g1', 'p1', 'editor', 'organization', 'acme', ${T})`,
	)
	expect(() =>
		db.run(
			`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g2', 'p1', 'editor', 'organization', 'globex', ${T})`,
		)
	).not.toThrow()
	// …but the SAME scope value twice is rejected.
	expect(() =>
		db.run(
			`INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, created_at) VALUES ('g3', 'p1', 'editor', 'organization', 'acme', ${T})`,
		)
	).toThrow()
})

test('inline grants are NOT constrained by the unique indexes — each is a distinct attachment', () => {
	const db = freshDb()
	seedP1(db)
	// Two identical inline grants (same principal, scope, app, permissions) — both allowed,
	// because the partial unique indexes only cover role_key IS NOT NULL.
	db.run(
		`INSERT INTO grants (id, principal_id, app, permissions, scope_type, scope_value, created_at) VALUES ('i1', 'p1', 'opice', '["report.export"]', 'team', 'acme', ${T})`,
	)
	expect(() =>
		db.run(
			`INSERT INTO grants (id, principal_id, app, permissions, scope_type, scope_value, created_at) VALUES ('i2', 'p1', 'opice', '["report.export"]', 'team', 'acme', ${T})`,
		)
	).not.toThrow()
})

test('the same GLOBAL role for DIFFERENT apps is allowed; the same app twice is rejected', () => {
	const db = freshDb()
	seedP1(db)
	db.run(`INSERT INTO grants (id, principal_id, role_key, app, created_at) VALUES ('g1', 'p1', 'editor', 'opice', ${T})`)
	// Same (principal, role) for a different app — allowed (the app dimension differentiates).
	expect(() => db.run(`INSERT INTO grants (id, principal_id, role_key, app, created_at) VALUES ('g2', 'p1', 'editor', 'poplach', ${T})`)).not.toThrow()
	// …but the same app twice is rejected.
	expect(() => db.run(`INSERT INTO grants (id, principal_id, role_key, app, created_at) VALUES ('g3', 'p1', 'editor', 'opice', ${T})`)).toThrow()
	// A NULL-app (all-apps) grant collides with another NULL-app one (COALESCE folds NULL→'*').
	db.run(`INSERT INTO grants (id, principal_id, role_key, app, created_at) VALUES ('g4', 'p1', 'viewer', NULL, ${T})`)
	expect(() => db.run(`INSERT INTO grants (id, principal_id, role_key, app, created_at) VALUES ('g5', 'p1', 'viewer', NULL, ${T})`)).toThrow()
})

test('at most one user principal per email (invite target uniqueness)', () => {
	const db = freshDb()
	seedP1(db, null, 'dup@x.cz')
	expect(() =>
		db.run(`INSERT INTO principals (id, type, external_id, email, label, created_at) VALUES ('p2', 'user', NULL, 'dup@x.cz', 'dup@x.cz', ${T})`)
	).toThrow()
})

test('a credential allows a NULL principal_id (anonymous share link) and a bound one', () => {
	const db = freshDb()
	seedP1(db)
	// Anonymous (no principal) — the share-link / standalone-key case.
	expect(() => db.run(`INSERT INTO credentials (id, token_hash, principal_id, created_at) VALUES ('c1', 'hA', NULL, ${T})`)).not.toThrow()
	// Principal-bound (live perms) — the API-key / personal-token case.
	expect(() => db.run(`INSERT INTO credentials (id, token_hash, principal_id, created_at) VALUES ('c2', 'hB', 'p1', ${T})`)).not.toThrow()
	// token_hash is UNIQUE.
	expect(() => db.run(`INSERT INTO credentials (id, token_hash, principal_id, created_at) VALUES ('c3', 'hA', NULL, ${T})`)).toThrow()
})

test('credential_grants scope is both-or-neither (scope_type and scope_value rise/fall together)', () => {
	const db = freshDb()
	db.run(`INSERT INTO credentials (id, token_hash, principal_id, created_at) VALUES ('c1', 'hA', NULL, ${T})`)
	// Half-set scopes are rejected.
	expect(() => db.run("INSERT INTO credential_grants (credential_id, action, scope_type, scope_value) VALUES ('c1', 'report.read', 'team', NULL)"))
		.toThrow()
	expect(() => db.run("INSERT INTO credential_grants (credential_id, action, scope_type, scope_value) VALUES ('c1', 'report.read', NULL, 'acme')"))
		.toThrow()
	// Both set, or both NULL (global) — ok.
	expect(() => db.run("INSERT INTO credential_grants (credential_id, action, scope_type, scope_value) VALUES ('c1', 'report.read', 'team', 'acme')"))
		.not.toThrow()
	expect(() => db.run("INSERT INTO credential_grants (credential_id, action) VALUES ('c1', 'report.export')")).not.toThrow()
})

test('credential_grants cascade-delete with the credential', () => {
	const db = freshDb()
	db.run(`INSERT INTO credentials (id, token_hash, principal_id, created_at) VALUES ('c1', 'hA', NULL, ${T})`)
	db.run("INSERT INTO credential_grants (credential_id, action) VALUES ('c1', 'report.read')")
	db.run("DELETE FROM credentials WHERE id = 'c1'")
	const remaining = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credential_grants WHERE credential_id = 'c1'").get()
	expect(remaining?.n).toBe(0)
})
