import type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from '@fabrika/platform'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { createIamRepositories, type IamRepositories } from '../../db'
import { OidcClient, type OidcMetadata } from '../../oidc'
import { hashToken } from '../../secret'
import type { Config, Services } from '../../services'
import { allMigrations } from './migrations'

/**
 * Shared test harness for the worker's auth/admin flows. Stands up:
 *   - a real in-memory `bun:sqlite` DB with the production migration applied,
 *     wrapped in a small `SqlDatabase` adapter so the repository capabilities run
 *     through the same port they use for D1 (mirrors the schema.test.ts pattern);
 *   - `signSession`, minting a real `px_session` SSO session for a seeded principal;
 *   - `makeServices({ environment, human, bootstrapAdmins, oidc })` assembling a
 *     plain native `Services`.
 *
 * Nothing here mocks the modules under test — the SQL runs against the real schema.
 */

/** Offline OIDC discovery metadata for the harness default client (no network in tests). */
export const HARNESS_OIDC_METADATA: OidcMetadata = {
	issuer: 'https://idp.test',
	authorizationEndpoint: 'https://idp.test/authorize',
	tokenEndpoint: 'https://idp.test/token',
	jwksUri: 'https://idp.test/jwks',
}

// ── `SqlDatabase` adapter over bun:sqlite ─────────────────────────────────────
// Repositories use the async SQL port (`prepare().bind().first()/.all()/.run()` and `batch()`) — the
// same surface a real `D1Database` satisfies structurally. bun:sqlite is synchronous, so we wrap
// it. Implementing the PORT (not D1) is deliberate: the tests then exercise exactly what a future
// Postgres driver has to provide, and nothing more. Typed end-to-end (the bun `Statement<ReturnType>`
// generic carries the row type through), so no casts.

class TestSqlStatement implements SqlStatement {
	private params: SQLQueryBindings[] = []

	constructor(private readonly db: Database, private readonly sql: string) {}

	bind(...values: unknown[]): SqlStatement {
		const next = new TestSqlStatement(this.db, this.sql)
		next.params = values.map((v) => toBinding(v))
		return next
	}

	first<T = Record<string, unknown>>(): Promise<T | null> {
		const row = this.db.query<T, SQLQueryBindings[]>(this.sql).get(...this.params)
		return Promise.resolve(row)
	}

	all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> {
		const results = this.db.query<T, SQLQueryBindings[]>(this.sql).all(...this.params)
		return Promise.resolve({ results })
	}

	run(): Promise<SqlRunResult> {
		const changes = this.db.query<Record<string, unknown>, SQLQueryBindings[]>(this.sql).run(...this.params)
		return Promise.resolve({ meta: { changes: changes.changes } })
	}
}

class TestSqlDatabase implements SqlDatabase {
	constructor(private readonly db: Database) {}

	prepare(query: string): SqlStatement {
		return new TestSqlStatement(this.db, query)
	}

	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		const out: SqlQueryResult<T>[] = []
		this.db.run('BEGIN')
		try {
			for (const stmt of statements) {
				out.push(await stmt.all<T>())
			}
			this.db.run('COMMIT')
		} catch (err) {
			this.db.run('ROLLBACK')
			throw err
		}
		return out
	}
}

/** Coerce a bound value into a bun:sqlite-acceptable binding (no `as`). */
function toBinding(value: unknown): SQLQueryBindings {
	if (
		value === null
		|| typeof value === 'string'
		|| typeof value === 'number'
		|| typeof value === 'bigint'
		|| typeof value === 'boolean'
	) {
		return value
	}
	if (value === undefined) {
		return null
	}
	throw new Error(`unsupported bind value of type ${typeof value}`)
}

// ── DB + services assembly ────────────────────────────────────────────────────

const migration = allMigrations()

export interface Harness {
	/** Raw sqlite connection — seed rows directly with `.run(...)`. */
	sqlite: Database
	/** Production persistence capabilities over the in-memory sqlite. */
	repositories: IamRepositories
	/**
	 * Create an active SSO session for a principal and return the plaintext `px_session` cookie value
	 * (the native admin/auth credential). Mirrors what `/auth/callback` does after a successful login.
	 */
	signSession(principalId: string, options?: SignSessionOptions): Promise<string>
	/** Build a native `Services` for the given environment + config. */
	makeServices(options?: MakeServicesOptions): Services
}

export interface SignSessionOptions {
	/** IdP `sub` recorded on the session row. */
	idpSub?: string
	/** Verified email recorded on the session row. */
	email?: string
	/** Absolute expiry (unix seconds); defaults to 1h out. */
	expiresAt?: number
}

export interface MakeServicesOptions {
	/** ENVIRONMENT value (e.g. 'local', 'stage'). Defaults to 'local'. */
	environment?: string
	/** Enable the explicit local-only human login bypass. */
	localDevLogin?: boolean
	/** IAM_BOOTSTRAP_ADMINS emails. Defaults to empty. */
	bootstrapAdmins?: ReadonlySet<string>
	/** Central human-admission allowlist. Defaults to `{ emailDomains: ['contember.com'], emails: [] }`. */
	human?: { emailDomains?: readonly string[]; emails?: readonly string[] }
	/** OIDC client. Defaults to one with injected (offline) discovery metadata; tests override for the callback flow. */
	oidc?: OidcClient
	/** propustka's own origin (token `iss` + OIDC redirect base). */
	issuer?: string
	/** SSO session cookie `Domain`; empty = host-only. */
	sessionCookieDomain?: string
}

/** Stand up a fresh in-memory DB + helpers. Call once per test for isolation. */
export function createHarness(): Harness {
	const sqlite = new Database(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	sqlite.exec(migration)
	const repositories = createIamRepositories(new TestSqlDatabase(sqlite))

	function makeServices(options: MakeServicesOptions = {}): Services {
		const issuer = options.issuer ?? 'http://localhost:18191'
		const environment = options.environment ?? 'local'
		const config: Config = {
			human: {
				emailDomains: options.human?.emailDomains ?? ['contember.com'],
				emails: options.human?.emails ?? [],
			},
			bootstrapAdmins: options.bootstrapAdmins ?? new Set(),
			environment,
			localDevLogin: environment === 'local' && options.localDevLogin === true,
			issuer,
			sessionCookieDomain: options.sessionCookieDomain ?? '',
		}
		return {
			repositories,
			oidc: options.oidc ?? new OidcClient(
				{
					issuer: 'https://idp.test',
					clientId: 'dummy',
					clientSecret: 'dummy',
					redirectUri: `${issuer}/auth/callback`,
					scopes: '',
					requireVerifiedEmail: true,
				},
				{ metadata: HARNESS_OIDC_METADATA },
			),
			config,
		}
	}

	async function signSession(principalId: string, options: SignSessionOptions = {}): Promise<string> {
		const token = nextId('sess')
		await repositories.sessions.createSession({
			tokenHash: await hashToken(token),
			principalId,
			idpSub: options.idpSub ?? `idp-${principalId}`,
			email: options.email ?? 'admin@example.com',
			expiresAt: options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
		})
		return token
	}

	return { sqlite, repositories, signSession, makeServices }
}

// ── Seeding helpers (direct INSERTs against the real schema) ──────────────────

let seq = 0
function nextId(prefix: string): string {
	seq += 1
	return `${prefix}-${seq}`
}

/**
 * `created_at` has no DDL default any more (`unixepoch()` is SQLite-only — see the header of
 * `migrations/0001_init.sql`), so every INSERT must bind it, these seeds included. Tests that
 * care about a specific creation time pass `createdAt`; the rest get "now".
 */
function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

export interface SeedUserOptions {
	/** Access `sub`. Null → an unclaimed invite. */
	sub?: string | null
	email: string
	label?: string
	disabled?: boolean
	/** `created_at` in unix seconds; defaults to now. */
	createdAt?: number
}

/** Insert a user principal; returns its id. */
export function seedUser(sqlite: Database, options: SeedUserOptions): string {
	const id = nextId('user')
	sqlite.run(
		'INSERT INTO principals (id, type, external_id, email, label, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[
			id,
			'user',
			options.sub ?? null,
			options.email,
			options.label ?? options.email,
			options.disabled ? 1 : null,
			options.createdAt ?? nowSeconds(),
		],
	)
	return id
}

export interface SeedServiceOptions {
	/** Access `common_name` (the service token Client ID). */
	commonName: string
	label?: string
	disabled?: boolean
	/** `created_at` in unix seconds; defaults to now. */
	createdAt?: number
}

/** Insert a service principal; returns its id. */
export function seedService(sqlite: Database, options: SeedServiceOptions): string {
	const id = nextId('svc')
	sqlite.run(
		'INSERT INTO principals (id, type, external_id, email, label, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[
			id,
			'service',
			options.commonName,
			null,
			options.label ?? options.commonName,
			options.disabled ? 1 : null,
			options.createdAt ?? nowSeconds(),
		],
	)
	return id
}

/** A flat scope coordinate for seeding ({ type, value }); null = global. */
export interface SeedScope {
	type: string
	value: string
}

/**
 * Insert a ROLE-BASED grant for a principal; returns its id. `scope` null → global,
 * `app` null → all apps (cross-app). The grant carries a named `roleKey` (the common
 * case in these tests); use `seedInlineGrant` for an inline action-pattern set.
 */
export function seedGrant(
	sqlite: Database,
	principalId: string,
	roleKey: string,
	scope: SeedScope | null = null,
	app: string | null = null,
): string {
	const id = nextId('grant')
	sqlite.run(
		'INSERT INTO grants (id, principal_id, role_key, scope_type, scope_value, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[id, principalId, roleKey, scope?.type ?? null, scope?.value ?? null, app, nowSeconds()],
	)
	return id
}

/** Insert an INLINE grant (an action-pattern set, no role) for a principal; returns its id. */
export function seedInlineGrant(
	sqlite: Database,
	principalId: string,
	permissions: string[],
	scope: SeedScope | null = null,
	app: string | null = null,
): string {
	const id = nextId('grant')
	sqlite.run(
		'INSERT INTO grants (id, principal_id, permissions, scope_type, scope_value, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[id, principalId, JSON.stringify(permissions), scope?.type ?? null, scope?.value ?? null, app, nowSeconds()],
	)
	return id
}

/** Insert a role row for an app (origin 'app' by default); returns its (app, role_key). */
export function seedRole(
	sqlite: Database,
	app: string,
	roleKey: string,
	permissions: string[],
	options: { name?: string; description?: string | null; origin?: 'app' | 'custom' } = {},
): void {
	sqlite.run(
		'INSERT INTO roles (app, role_key, name, description, permissions, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		[app, roleKey, options.name ?? roleKey, options.description ?? null, JSON.stringify(permissions), options.origin ?? 'app', nowSeconds()],
	)
}

/** Insert an action-catalog row for an app. */
export function seedAppAction(sqlite: Database, app: string, action: string, description: string | null = null): void {
	sqlite.run('INSERT INTO app_actions (app, action, description) VALUES (?, ?, ?)', [app, action, description])
}

/** Insert a scope-dimension row for an app. */
export function seedAppScope(sqlite: Database, app: string, scopeType: string, label: string | null = null): void {
	sqlite.run('INSERT INTO app_scopes (app, scope_type, label) VALUES (?, ?, ?)', [app, scopeType, label])
}
