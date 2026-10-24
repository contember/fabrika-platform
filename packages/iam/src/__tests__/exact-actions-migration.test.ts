import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { migrationFile, migrationsBefore } from './helpers/migrations'

// 0027 is the preflight for the end of wildcard resolution at a contract application: it refuses, before anything is
// lost, while such an application holds a pattern. Applied one statement at a time, as `wrangler d1 migrations apply`
// does: Bun's `Database.exec()` swallows a step error and runs on.

const FILE = '0027_application_exact_actions.sql'
const T = 1_782_896_400

function upgrade(seed: (db: Database) => void): () => void {
	const db = new Database(':memory:')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec(migrationsBefore(FILE))
	db.run(
		`INSERT INTO principals (id, type, external_id, email, label, activated_at, created_at) VALUES ('p1', 'user', 's1', 'a@x.cz', 'a@x.cz', ${T}, ${T})`,
	)
	db.run(`INSERT INTO contract_apps (app, created_at) VALUES ('crm@prod', ${T})`)
	seed(db)
	return () => {
		for (const statement of statementsOf(migrationFile(FILE))) db.run(statement)
	}
}

/** The file's statements, comments dropped. */
function statementsOf(sql: string): string[] {
	return sql
		.split('\n')
		.filter((line) => !line.startsWith('--'))
		.join('\n')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '')
}

describe('0027: a contract application holds no wildcard before IAM stops resolving one', () => {
	test('exact actions, and a pattern at an application that is not a contract one, upgrade', () => {
		const apply = upgrade((db) => {
			db.run(
				`INSERT INTO grants (id, principal_id, app, role_key, scope_type, scope_value, created_at) VALUES ('g1', 'p1', 'crm@prod', 'manager', 'org', 'o1', ${T})`,
			)
			db.run(`INSERT INTO grants (id, principal_id, app, permissions, created_at) VALUES ('g2', 'p1', 'crm@prod', '["crm.read"]', ${T})`)
			db.run(`INSERT INTO grants (id, principal_id, app, permissions, created_at) VALUES ('g3', 'p1', 'vozka', '["control.*"]', ${T})`)
			db.run(`INSERT INTO grants (id, principal_id, app, role_key, created_at) VALUES ('g4', 'p1', NULL, 'admin', ${T})`)
		})
		expect(apply).not.toThrow()
	})

	const refusing: ReadonlyArray<readonly [string, string]> = [
		['an inline pattern', `INSERT INTO grants (id, principal_id, app, permissions, created_at) VALUES ('g1', 'p1', 'crm@prod', '["crm.*"]', ${T})`],
		['the built-in admin', `INSERT INTO grants (id, principal_id, app, role_key, created_at) VALUES ('g1', 'p1', 'crm@prod', 'admin', ${T})`],
		[
			'a role naming a pattern',
			`INSERT INTO roles (app, role_key, name, permissions, origin, created_at) VALUES ('crm@prod', 'all', 'All', '["*"]', 'custom', ${T})`,
		],
	]
	for (const [what, seed] of refusing) {
		test(`${what} at a contract application refuses the upgrade`, () => {
			expect(upgrade((db) => db.run(seed))).toThrow('contract app holds a wildcard')
		})
	}

	test("a key's frozen pattern refuses the upgrade", () => {
		const apply = upgrade((db) => {
			db.run(`INSERT INTO credentials (id, token_hash, issued_by, app, created_at) VALUES ('k1', 'h1', 'p1', 'crm@prod', ${T})`)
			db.run(`INSERT INTO credential_grants (credential_id, action) VALUES ('k1', 'deals.*')`)
		})
		expect(apply).toThrow('contract app holds a wildcard')
	})
})
