// `fabrika operations` against the real Operations operator RPC, served through the Cloudflare Worker adapter with the
// Cloudflare composition's stores (SQLite repositories as on D1, an R2-shaped payload bucket). What stands in front of
// it is a fake console: its proxy mints a token from a `px_` key (ADR-0022 rule 3), and Control's gateway forwards
// `/operations/api/rpc` to Operations' `/api/rpc` (`packages/control/src/operations-gateway.ts`).

import { createRpcClient, type RpcFetch } from '@fabrika/app'
import { createCloudflareWorker } from '@fabrika/app/cloudflare'
import { buildAccessClaims, type IamRpc, type Jwks, type PermissionEntry, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import type { OperationsRpcContract } from '@fabrika/operations-contract/rpc'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { OPERATIONS_EXIT, type OperationsIo, runOperationsCli } from '../../../cli/src/operations.js'
import { operationsApp, type OperationsAppEnv } from '../app.js'
import { createOperationsIam } from '../auth.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { cloudflareBlobStore, type CloudflareBucketLike } from '../platform-cf.js'
import { emptyIamBinding } from './helpers/iam.js'
import { createHarness } from './helpers/sqlite.js'

const ISSUER = 'https://iam.example.test'
const CONSOLE = 'https://console.example.test'
const READER_KEY = 'px_reader_0123456789abcdef'
const DEPLOYER_KEY = 'px_deployer_0123456789abcdef'
const RECEIVED_AT = Date.UTC(2026, 10, 5, 12, 0, 0)

const { publicKey, privateKey } = await generateKeyPair('ES256')
const exported = await exportJWK(publicKey)
const jwks: Jwks = { keys: [{ kty: 'EC', crv: exported.crv, x: exported.x, y: exported.y, kid: 'cli-read', alg: 'ES256', use: 'sig' }] }

/** What each key holds in the console app: the reader `operations.read` at app `shop`, the deployer no Operations action. */
const GRANTS: Readonly<Record<string, readonly PermissionEntry[]>> = {
	[READER_KEY]: [{ action: 'operations.read', scope: { type: 'app', value: 'shop' }, source: 'grant' }],
	[DEPLOYER_KEY]: [{ action: 'deploy.read', scope: null, source: 'grant' }],
}

/** Control's `consoleAccess` answer for those grants. */
const consoleAccessOf = (grants: readonly PermissionEntry[]) => ({
	principal: { id: 'support-1', label: 'support' },
	global: grants.filter((grant) => grant.scope === null).map((grant) => grant.action),
	scopes: grants.flatMap((grant) => grant.scope === null ? [] : [{ type: grant.scope.type, value: grant.scope.value, actions: [grant.action] }]),
})

/** The token the console's proxy mints from a key: the console app's audience and the key's grants. */
const mintFromKey = async (grants: readonly PermissionEntry[]): Promise<string> => {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: ISSUER,
		app: 'vozka',
		subject: 'support-1',
		type: 'user',
		label: 'support',
		permissions: [...grants],
		issuedAt: now,
		expiresAt: now + 300,
	})
	return new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: 'cli-read' }).sign(privateKey)
}

const memoryBucket = (): CloudflareBucketLike => {
	const objects = new Map<string, string>()
	return {
		put: async (key, value) => void objects.set(key, typeof value === 'string' ? value : await new Response(value).text()),
		get: async (key) => {
			const text = objects.get(key)
			return text === undefined ? null : { body: new Response(text).body ?? new ReadableStream(), text: async () => text }
		},
		delete: async (key) => void objects.delete(key),
	}
}

const SENTRY_EVENT = {
	event_id: 'a'.repeat(32),
	platform: 'javascript',
	release: 'shop@abc123',
	environment: 'prod',
	request: { url: 'https://shop.example/checkout', method: 'POST' },
	exception: {
		values: [{
			type: 'TypeError',
			value: 'cannot read total\x1b[2J',
			mechanism: { handled: false },
			stacktrace: { frames: [{ filename: 'src/checkout.ts', function: 'pay', lineno: 10, colno: 4, in_app: true }] },
		}],
	},
}

/** Operations, seeded with one source per environment of `shop` and of `other`, and one issue on `shop` prod. */
const seededOperations = async (): Promise<{ env: OperationsAppEnv; issueId: string }> => {
	const harness = createHarness()
	const iam: IamRpc = { ...emptyIamBinding, getJwks: () => Promise.resolve(jwks) }
	const env: OperationsAppEnv = {
		repositories: harness.repositories,
		publicHost: 'errors.example.test',
		syncKey: 'catalog-sync-key-with-at-least-32-characters',
		ingestQueue: { send: () => Promise.resolve() },
		payloads: cloudflareBlobStore(memoryBucket()),
		health: new SqliteHealthRepository(harness.db),
		iam: createOperationsIam({ IAM: iam, FABRIKA_IAM_ISSUER: ISSUER }),
	}
	for (
		const source of [
			{ id: 'shop-prod', appId: 'shop', environment: 'prod' },
			{ id: 'shop-stage', appId: 'shop', environment: 'stage' },
			{ id: 'other-prod', appId: 'other', environment: 'prod' },
		]
	) {
		await harness.repositories.sources.upsert({ ...source, displayName: source.id, enabled: true })
	}
	await env.payloads.put('event-a', JSON.stringify(SENTRY_EVENT))
	const recorded = await harness.repositories.ingest.record({
		sourceId: 'shop-prod',
		fingerprint: 'checkout-total',
		eventId: SENTRY_EVENT.event_id,
		title: 'TypeError: cannot read total',
		culprit: 'src/checkout.ts',
		level: 'error',
		release: 'shop@abc123',
		receivedAt: RECEIVED_AT,
		blobKey: 'event-a',
	})
	const issueId = recorded.issue.id
	if (issueId === null) throw new Error('expected an issue id')
	return { env, issueId }
}

/** The console in front of Operations: the proxy's key exchange, Control's `consoleAccess`, and its gateway hop. */
const fakeConsole = (env: OperationsAppEnv): RpcFetch => {
	const worker = createCloudflareWorker(operationsApp)
	return async (input, init) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
		const grants = GRANTS[key]
		if (grants === undefined) return Response.json({ error: { type: 'auth', message: 'authentication required' } }, { status: 401 })
		const token = await mintFromKey(grants)
		if (url.pathname === '/api/rpc') return Response.json({ result: consoleAccessOf(grants) })
		if (url.pathname !== '/operations/api/rpc') return Response.json({ error: { type: 'forbidden', message: 'no endpoint' } }, { status: 403 })
		const headers = new Headers(request.headers)
		headers.set('authorization', `Bearer ${token}`)
		headers.set(PROXY_TOKEN_HEADER, token)
		const hop = new Request('https://operations.internal/api/rpc', { method: 'POST', headers, body: await request.text() })
		return worker.fetch(hop, env, { waitUntil: () => undefined, passThroughOnException: () => undefined })
	}
}

const runAgainst = async (env: OperationsAppEnv, key: string, argv: readonly string[]): Promise<{ code: number; out: string; err: string }> => {
	const out: string[] = []
	const err: string[] = []
	const io: OperationsIo = {
		env: { FABRIKA_CONTROL_URL: CONSOLE, FABRIKA_CONTROL_KEY: key },
		fetch: fakeConsole(env),
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	}
	const [command, ...rest] = argv
	const code = await runOperationsCli(command, rest, io)
	return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('fabrika operations against Operations on the Cloudflare adapter', () => {
	test('the fake console reaches the real operator RPC', async () => {
		const { env } = await seededOperations()
		const client = createRpcClient<OperationsRpcContract>({
			baseUrl: `${CONSOLE}/operations/api/rpc`,
			fetch: (input, init) => fakeConsole(env)(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${READER_KEY}` } }),
		})
		expect(await client.sources()).toMatchObject({ items: [{ id: 'shop-prod' }, { id: 'shop-stage' }] })
	})

	test("issues lists the reader's issues of one environment; another app's source is not found", async () => {
		const { env, issueId } = await seededOperations()
		const listed = await runAgainst(env, READER_KEY, ['issues', '--app=shop', '--env=prod', '--status=open'])
		expect(listed.code).toBe(OPERATIONS_EXIT.ok)
		expect(listed.out).toBe(`${issueId}\topen\terror\t1\t2026-11-05T12:00:00.000Z\tshop\tprod\tdefault\tTypeError: cannot read total`)
		expect(listed.err).toContain('1 issues in this selection, any status: 1 open')

		const ambiguous = await runAgainst(env, READER_KEY, ['issues', '--app=shop'])
		expect(ambiguous.code).toBe(OPERATIONS_EXIT.usage)

		const elsewhere = await runAgainst(env, READER_KEY, ['issues', '--app=other'])
		expect(elsewhere.code).toBe(OPERATIONS_EXIT.notFound)
	})

	test('issue prints the latest event, read from the payload bucket, with its text as data', async () => {
		const { env, issueId } = await seededOperations()
		const shown = await runAgainst(env, READER_KEY, ['issue', issueId])
		expect(shown.code).toBe(OPERATIONS_EXIT.ok)
		const lines = shown.out.split('\n')
		expect(lines).toContain('request\tPOST\thttps://shop.example/checkout')
		expect(lines).toContain('exception\tTypeError\tunhandled\tcannot read total[2J')
		expect(lines).toContain('frame\tsrc/checkout.ts:10:4\tpay\tapp')

		const json = await runAgainst(env, READER_KEY, ['issue', issueId, '--json'])
		expect(JSON.parse(json.out)).toMatchObject({ issue: { id: issueId }, event: { detail: { eventId: SENTRY_EVENT.event_id } } })
		// The raw event rides along as a JSON string, its escape sequence still escaped.
		expect(json.out).toContain('"rawEvent": "')
		expect(json.out).toContain('cannot read total\\u001b[2J')
		expect(json.out).not.toContain('\x1b')
	})

	test('releases and health answer for the reader', async () => {
		const { env } = await seededOperations()
		const releases = await runAgainst(env, READER_KEY, ['releases', '--app=shop', '--env=prod'])
		expect(releases).toMatchObject({ code: OPERATIONS_EXIT.ok, out: '' })
		const health = await runAgainst(env, READER_KEY, ['health', '--app=shop'])
		expect(health.code).toBe(OPERATIONS_EXIT.ok)
		expect(health.out.split('\n')).toEqual(['source\tshop\tprod\tdefault\tunavailable', 'source\tshop\tstage\tdefault\tunavailable'])
	})

	test('a key without operations.read, and a key the console does not know, are exit 3', async () => {
		const { env } = await seededOperations()
		const deployer = await runAgainst(env, DEPLOYER_KEY, ['issues'])
		expect(deployer.code).toBe(OPERATIONS_EXIT.credential)
		expect(deployer.err).toContain('does not hold operations.read')
		const unknown = await runAgainst(env, 'px_unknown', ['health'])
		expect(unknown.code).toBe(OPERATIONS_EXIT.credential)
	})
})
