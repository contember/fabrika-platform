// The public intake witness of WU15 against the real IAM through the proxy's decision: the fixture application of
// `@fabrika/app`'s intake test, booted on a real Postgres, its intake job exchanging its own key at IAM's workload token
// route and issuing through IAM's `issueLink`, and every visitor request decided by proxy-core's `Authorizer` over the
// endpoint table the contract compiles to, with IAM minting from the presented key. IAM runs on its SQLite harness.

import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { boot, type ContractApp, issuerWorkloadTokens } from '@fabrika/app/implement'
import {
	compileEndpointTable,
	contractDigest,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	FABRIKA_CONTRACT_DIGEST,
	type MembershipFailure,
	PROXY_TOKEN_HEADER,
	TOKEN_REFRESH_SKEW_SECONDS,
	WORKLOAD_TOKEN_PATH,
	workloadKeyVariable,
} from '@fabrika/auth-core'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { MemoryFileObjects, unusedDatabase } from '@fabrika/platform/testing'
import { Authorizer, MemoryTokenCache, type ResolvedApp } from '@fabrika/proxy-core'
import { type ContractProxyApp, contractProxyTable } from '@fabrika/proxy-core/manifest'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { echoAssets, environment } from '../../../app/src/__tests__/fixtures/implement/harness'
import { contract } from '../../../app/src/__tests__/fixtures/visitor-intake/fabrika.contract'
import { migration } from '../../../app/src/__tests__/fixtures/visitor-intake/migration'
import { intakeApp } from '../../../app/src/__tests__/fixtures/visitor-intake/src/app'
import { tables } from '../../../app/src/__tests__/fixtures/visitor-intake/src/db/tables'
import type { DeliveryStep, IntakeWorld } from '../../../app/src/__tests__/fixtures/visitor-intake/src/world'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { createIamRpc } from '../rpc'
import { createHarness, type Harness, TEST_SIGNING_KEYS } from './helpers/harness'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`visitor-link.test.ts skipped: set ${URL_VAR} to run it (the fixture application runs on @fabrika/db)`)
}

const ISSUER = 'https://iam.intake.test'
const HOST = 'intake.test'
const APP = 'intake@prod'
const PROVISIONING_KEY = `px_${'p'.repeat(43)}`
const DAY = 24 * 60 * 60
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')
const exec = { waitUntil() {} }
const schema = applicationSchema(`visitor-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const opened: Database[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

function iamEnv(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

class World implements IntakeWorld {
	readonly origin = `https://${HOST}`
	readonly mails: { readonly to: string; readonly url: string }[] = []

	send(message: { readonly to: string; readonly url: string }): Promise<void> {
		this.mails.push(message)
		return Promise.resolve()
	}

	after(_step: DeliveryStep): Promise<void> {
		return Promise.resolve()
	}

	lastKey(to: string): string {
		const mail = this.mails.filter((message) => message.to === to).at(-1)
		if (mail === undefined) throw new Error(`no link was e-mailed to ${to}`)
		return new URL(mail.url).hash.slice(1)
	}
}

interface VisitOptions {
	readonly key?: string
	/** A JSON body, sent with POST. */
	readonly body?: unknown
	/** A file's bytes and their media type, sent with POST. */
	readonly file?: { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }
}

interface Stack {
	readonly world: World
	readonly app: ContractApp
	readonly h: Harness
	readonly env: Env
	/** The proxy's clock, Unix seconds: a test moves it to let a cached token come due. */
	clock: number
	/** A request decided by the proxy and, when allowed, forwarded to the application with what the proxy adds. */
	visit(path: string, options?: VisitOptions): Promise<{ readonly status: number; readonly body: unknown }>
	runJob(): Promise<unknown>
	reconcile(withIssues: boolean): Promise<void>
	jobToken(): Promise<string>
}

async function stack(): Promise<Stack> {
	const world = new World()
	const { implementation, variables } = intakeApp(world)
	const artifact = compileContract(contract, tables)
	const h = createHarness()
	const env = iamEnv(h)
	const iamApp = createIamApp()
	const iam = (path: string, init: { method: string; bearer: string; body: unknown }) =>
		iamApp.fetch(
			new Request(`${ISSUER}${path}`, {
				method: init.method,
				headers: { authorization: `Bearer ${init.bearer}`, 'content-type': 'application/json' },
				body: JSON.stringify(init.body),
			}),
			env,
			exec,
		)
	const reconcile = async (withIssues: boolean): Promise<void> => {
		const declared = schemaFromContract(artifact)
		const workloads = (declared.workloads ?? []).map((workload) =>
			withIssues || workload.kind !== 'job' ? workload : { kind: workload.kind, name: workload.name, actions: workload.actions }
		)
		const response = await iam(`/admin/apps/${encodeURIComponent(APP)}/schema`, {
			method: 'PUT',
			bearer: PROVISIONING_KEY,
			body: { ...declared, workloads },
		})
		if (response.status !== 200) throw new Error(`IAM refused the schema: ${await response.text()}`)
	}
	await reconcile(true)
	const issued = await iam('/admin/rpc', {
		method: 'POST',
		bearer: PROVISIONING_KEY,
		body: {
			method: 'workloads.issueKey',
			input: { app: APP, kind: 'job', name: 'intake', expiresAt: Math.floor(Date.now() / 1000) + 30 * DAY, keep: null },
		},
	})
	const jobKey = prop(prop(await issued.json(), 'result'), 'key')
	if (typeof jobKey !== 'string') throw new Error('IAM issued no key for the intake job')

	const rpc = createIamRpc(env, exec)
	const connection = Database.postgres({ url, schema, max: 2 })
	opened.push(connection)
	const workloadTokens = issuerWorkloadTokens(ISSUER, (request) => iamApp.fetch(request, env, exec))
	const app = boot(implementation, {
		environment: environment({
			...variables,
			FABRIKA_IAM_APP_ID: APP,
			FABRIKA_IAM_ISSUER: ISSUER,
			[FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact),
			[workloadKeyVariable('job', 'intake')]: jobKey,
		}),
		iam: { getJwks: () => rpc.getJwks() },
		assets: echoAssets,
		workloadTokens,
		membership: rpc,
		database: connection,
		files: new MemoryFileObjects(),
	})

	const proxied: ContractProxyApp = { id: APP, hosts: [HOST], upstream: 'app', scheme: 'https', ...contractProxyTable(artifact) }
	const resolved: ResolvedApp = { app: proxied, table: compileEndpointTable(proxied) }
	const state: Stack = {
		world,
		app,
		h,
		env,
		clock: Math.floor(Date.now() / 1000),
		async visit(path, options = {}) {
			const headers = new Headers({
				'Content-Type': options.file?.type ?? 'application/json',
				'Sec-Fetch-Site': 'same-origin',
				'Sec-Fetch-Mode': 'cors',
			})
			if (options.key !== undefined) headers.set('Authorization', `Bearer ${options.key}`)
			const method = options.body === undefined && options.file === undefined ? 'GET' : 'POST'
			const requestId = Bun.randomUUIDv7()
			const decision = await authorizer.authorize(resolved, { method, url: new URL(path, `https://${HOST}`), rawPath: path, headers, requestId })
			if (decision.outcome !== 'allow') {
				return { status: decision.outcome === 'deny' || decision.outcome === 'login' ? decision.status : 302, body: decision.outcome }
			}
			const forwarded = new Headers(headers)
			forwarded.delete('Authorization')
			forwarded.set(ENDPOINT_HEADER, decision.endpoint)
			forwarded.set('X-Request-Id', requestId)
			if (decision.token !== null) forwarded.set(PROXY_TOKEN_HEADER, decision.token)
			if (decision.delegation !== null) forwarded.set(DELEGATION_HEADER, decision.delegation)
			const body = options.file?.bytes ?? (options.body === undefined ? null : JSON.stringify(options.body))
			const response = await app.fetch(new Request(`https://${HOST}${path}`, { method, headers: forwarded, body }))
			const text = await response.text()
			let parsed: unknown = text
			try {
				parsed = JSON.parse(text)
			} catch {
				// An SPA file stays text.
			}
			return { status: response.status, body: parsed }
		},
		runJob() {
			const log = spyOn(console, 'error').mockImplementation(() => {})
			return app.jobs.run('intake', { reporter: { report: () => Promise.resolve() } }).finally(() => log.mockRestore())
		},
		reconcile,
		async jobToken() {
			const response = await iamApp.fetch(
				new Request(`${ISSUER}${WORKLOAD_TOKEN_PATH}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${jobKey}`, 'content-type': 'application/json' },
					body: JSON.stringify({ app: APP }),
				}),
				env,
				exec,
			)
			const token = prop(await response.json(), 'token')
			if (typeof token !== 'string') throw new Error('IAM signed no token for the intake job')
			return token
		},
	}
	const authorizer = new Authorizer({ iam: rpc, issuer: ISSUER, cache: new MemoryTokenCache(), now: () => state.clock })
	return state
}

function resultOf(sent: { readonly status: number; readonly body: unknown }): unknown {
	if (sent.status !== 200) throw new Error(`expected a result, got ${sent.status} ${JSON.stringify(sent.body)}`)
	return prop(sent.body, 'result')
}

describe.skipIf(!hasPostgres)('an anonymous visitor through the proxy and the real IAM', () => {
	test("a form row becomes a candidate, the job's link is bound to it, and its holder verifies once", async () => {
		const s = await stack()
		expect(resultOf(await s.visit('/register', { body: { email: 'ada@example.test', name: 'Ada' } }))).toEqual({ received: true })
		expect(await s.runJob()).toEqual({ status: 'succeeded', attempts: 1 })

		const [row] = await admin((sql) => sql.unsafe(`select id, link_id from ${schema}.candidates where email = 'ada@example.test'`))
		const credential = await s.h.repositories.credentials.getCredentialById(String(row?.link_id))
		const workload = await s.h.repositories.workloads.findPrincipalId(APP, 'job', 'intake')
		expect({ issuer: credential?.issued_by, mount: credential?.link_mount, chain: credential?.link_chain }).toEqual({
			issuer: workload,
			mount: 'portal',
			chain: JSON.stringify([{ type: 'candidate', value: row?.id }]),
		})

		const key = s.world.lastKey('ada@example.test')
		const first = resultOf(await s.visit('/p/api/verify', { key, body: {} }))
		expect(resultOf(await s.visit('/p/api/verify', { key, body: {} }))).toEqual(first)
		const [verified] = await admin((sql) => sql.unsafe(`select verified_at from ${schema}.candidates where email = 'ada@example.test'`))
		expect(first).toEqual({ verifiedAt: new Date(verified?.verified_at).toISOString() })
		expect(resultOf(await s.visit('/p/api/me', { key, body: {} }))).toEqual({ name: 'Ada', email: 'ada@example.test', verified: true })
		// The link reaches only its own mount's procedures; without a key the proxy stops the request.
		expect((await s.visit('/p/api/me', { body: {} })).status).toBe(401)
	})

	test("a holder uploads to and downloads from its own record only; another record's file is 404", async () => {
		const s = await stack()
		await s.visit('/register', { body: { email: 'eve@example.test', name: 'Eve' } })
		await s.visit('/register', { body: { email: 'fay@example.test', name: 'Fay' } })
		expect(await s.runJob()).toEqual({ status: 'succeeded', attempts: 1 })
		const eve = s.world.lastKey('eve@example.test')
		const fay = s.world.lastKey('fay@example.test')
		const upload = (key: string) => s.visit('/p/api/files.attachments.upload', { key, file: { bytes: PDF, type: 'application/pdf' } })

		const own = prop(resultOf(await upload(eve)), 'id')
		const theirs = prop(resultOf(await upload(fay)), 'id')
		if (typeof own !== 'string' || typeof theirs !== 'string') throw new Error('expected two uploads')
		const owners = await admin((sql) =>
			sql.unsafe(
				`select c.email from ${schema}.fabrika_files_attachments f join ${schema}.candidates c on c.id = f.owner_id where f.id in ($1, $2) order by c.email`,
				[
					own,
					theirs,
				],
			)
		)
		expect(owners.map((row: { email: string }) => row.email)).toEqual(['eve@example.test', 'fay@example.test'])
		const downloaded = await s.visit(`/p/api/files.attachments/${own}`, { key: eve })
		expect(downloaded.status).toBe(200)
		expect(downloaded.body).toBe(new TextDecoder().decode(PDF))
		expect((await s.visit(`/p/api/files.attachments/${theirs}`, { key: eve })).status).toBe(404)
		const listed = prop(resultOf(await s.visit('/p/api/files.attachments.list', { key: eve, body: {} })), 'items')
		expect(Array.isArray(listed) ? listed.map((item: unknown) => prop(item, 'id')) : listed).toEqual([own])
	})

	test('a link the job revoked keeps working only until the proxy must refresh its cached token', async () => {
		const s = await stack()
		await s.visit('/register', { body: { email: 'bo@example.test', name: 'Bo' } })
		await s.runJob()
		const superseded = s.world.lastKey('bo@example.test')
		expect(resultOf(await s.visit('/p/api/me', { key: superseded, body: {} }))).toMatchObject({ name: 'Bo' })

		expect(resultOf(await s.visit('/resend', { body: { email: 'bo@example.test' } }))).toEqual({ received: true })
		expect(await s.runJob()).toEqual({ status: 'succeeded', attempts: 1 })
		const current = s.world.lastKey('bo@example.test')
		expect(current).not.toBe(superseded)

		// The proxy honours its cached token without asking IAM: a revoked link works for the rest of that token's life.
		expect((await s.visit('/p/api/me', { key: superseded, body: {} })).status).toBe(200)
		s.clock += 300 - TOKEN_REFRESH_SKEW_SECONDS
		expect(await s.visit('/p/api/me', { key: superseded, body: {} })).toMatchObject({ status: 401 })
		expect((await s.visit('/p/api/me', { key: current, body: {} })).status).toBe(200)
	})

	test("IAM refuses the job's link operations once the approved schema stops declaring issues, and every other membership operation always", async () => {
		const s = await stack()
		const rpc = createIamRpc(s.env, exec)
		const token = await s.jobToken()
		const caller = { app: APP, credential: token, requestId: Bun.randomUUIDv7() }
		const refused: MembershipFailure = { ok: false, reason: 'invalid_token' }
		expect(
			await rpc.assignMember({
				...caller,
				delegation: 'none',
				scope: { type: 'candidate', value: 'c1' },
				role: 'hr',
				member: { email: 'x@example.test' },
			}),
		)
			.toEqual(refused)
		expect(await rpc.listMembers({ ...caller, scope: { type: 'candidate', value: 'c1' } })).toEqual(refused)

		await s.reconcile(false)
		await s.visit('/register', { body: { email: 'cy@example.test', name: 'Cy' } })
		expect(await s.runJob()).toMatchObject({ status: 'failed', code: 'handler_failed' })
		expect(s.world.mails).toEqual([])
		expect(await rpc.issueLink({ ...caller, mount: 'portal', chain: [{ type: 'candidate', value: 'c1' }], days: 1 })).toEqual({
			ok: false,
			reason: 'not_allowed',
		})
	})
})
