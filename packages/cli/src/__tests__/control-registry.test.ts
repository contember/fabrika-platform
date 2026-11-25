import { OAUTH_REGISTRY_NOT_IMPORTED } from '@fabrika/iam-contract'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROL_USAGE, runControlCli } from '../control.js'

const KEY = 'px_provisioning_secret'
const ENV: Readonly<Record<string, string>> = { FABRIKA_IAM_RPC_URL: 'https://iam.example', FABRIKA_IAM_PROVISIONING_KEY: KEY }

interface Sent {
	readonly url: string
	readonly authorization: string | null
	readonly redirect: RequestRedirect | undefined
	readonly body: unknown
}

const realFetch = globalThis.fetch

/** Answer every request with `answer` and record what the client sent. */
const fakeIam = (answer: () => Response): Sent[] => {
	const sent: Sent[] = []
	const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = init?.body
		sent.push({
			url: String(input),
			authorization: new Headers(init?.headers).get('authorization'),
			redirect: init?.redirect,
			body: typeof raw === 'string' ? JSON.parse(raw) : null,
		})
		return answer()
	}
	globalThis.fetch = Object.assign(handler, { preconnect: realFetch.preconnect })
	return sent
}

const answering = (result: unknown) => () => Response.json({ result })

const capture = async (run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> => {
	const out: string[] = []
	const err: string[] = []
	const info = console.info
	const warn = console.warn
	console.info = (...args: unknown[]) => void out.push(args.map(String).join(' '))
	console.warn = (...args: unknown[]) => void err.push(args.map(String).join(' '))
	try {
		await run()
	} finally {
		console.info = info
		console.warn = warn
	}
	return { stdout: out.join('\n'), stderr: err.join('\n') }
}

let directory = ''

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'fabrika-cli-registry-'))
})

afterAll(async () => {
	await rm(directory, { recursive: true, force: true })
})

afterEach(() => {
	globalThis.fetch = realFetch
})

const file = async (name: string, value: unknown): Promise<string> => {
	const path = join(directory, name)
	await Bun.write(path, JSON.stringify(value))
	return path
}

const APP_FILE = {
	app: 'ops-tool',
	name: 'Ops tool',
	resource: 'https://ops.example.com',
	clients: [{ clientId: 'https://ops.example.com/oauth/client.json', redirectUris: ['https://ops.example.com/cb'] }],
}

const STORED = {
	...APP_FILE,
	roles: [{ key: 'viewer', name: 'Viewer' }],
	clients: [{ clientId: 'https://ops.example.com/oauth/client.json', redirectUris: ['https://ops.example.com/cb'], metadataUrl: null }],
	createdAt: 1,
	updatedAt: 2,
}

describe('control external-apps', () => {
	test("list calls IAM's admin RPC with the provisioning key, follows no redirect, and prints one row per application", async () => {
		const sent = fakeIam(answering({ items: [STORED] }))
		const { stdout } = await capture(() => runControlCli('external-apps', ['list'], undefined, ENV))
		expect(sent).toEqual([{
			url: 'https://iam.example/admin/rpc',
			authorization: `Bearer ${KEY}`,
			redirect: 'manual',
			body: { method: 'externalApps.list', input: null },
		}])
		expect(stdout).toBe('ops-tool\tOps tool\thttps://ops.example.com\t1 roles\t1 clients')
	})

	test('put sends the file as the whole application, without roles as null', async () => {
		const sent = fakeIam(answering({ ...STORED, roles: null }))
		const path = await file('app.json', APP_FILE)
		await capture(() => runControlCli('external-apps', ['put', `--file=${path}`], undefined, ENV))
		expect(sent[0]?.body).toEqual({
			method: 'externalApps.put',
			input: { ...APP_FILE, roles: null, clients: [{ ...APP_FILE.clients[0], metadataUrl: null }] },
		})
	})

	test('get prints the file put takes back; --json the answer as it is', async () => {
		fakeIam(answering(STORED))
		const { stdout } = await capture(() => runControlCli('external-apps', ['get', 'ops-tool'], undefined, ENV))
		expect(JSON.parse(stdout)).toEqual({ app: 'ops-tool', name: 'Ops tool', resource: STORED.resource, roles: STORED.roles, clients: STORED.clients })
		const json = await capture(() => runControlCli('external-apps', ['get', 'ops-tool', '--json'], undefined, ENV))
		expect(JSON.parse(json.stdout)).toEqual(STORED)
	})

	test('delete names the application positionally', async () => {
		const sent = fakeIam(answering({ ok: true }))
		const { stdout } = await capture(() => runControlCli('external-apps', ['delete', 'ops-tool'], undefined, ENV))
		expect(sent[0]?.body).toEqual({ method: 'externalApps.delete', input: { app: 'ops-tool' } })
		expect(stdout).toBe('deleted')
	})

	test('refuses a missing or extra argument and an unknown verb before any request', async () => {
		const sent = fakeIam(answering({ ok: true }))
		await expect(runControlCli('external-apps', ['get'], undefined, ENV)).rejects.toThrow('`control external-apps get` needs an app id')
		await expect(runControlCli('external-apps', ['delete', 'a', 'b'], undefined, ENV)).rejects.toThrow('takes only an app id')
		await expect(runControlCli('external-apps', ['put'], undefined, ENV)).rejects.toThrow('--file is required')
		await expect(runControlCli('external-apps', ['remove', 'a'], undefined, ENV)).rejects.toThrow('Unknown `control external-apps` verb: remove')
		await expect(runControlCli('external-apps', ['list', 'ops-tool'], undefined, ENV)).rejects.toThrow('`control external-apps list` takes no argument')
		await expect(runControlCli('oauth-clients', ['list', 'x'], undefined, ENV)).rejects.toThrow('`control oauth-clients list` takes no argument')
		expect(sent).toEqual([])
	})

	test('put checks the file against the contract and sends nothing it would refuse', async () => {
		const sent = fakeIam(answering({ ok: true }))
		const shape = await file('shape.json', { ...APP_FILE, extra: true })
		await expect(runControlCli('external-apps', ['put', `--file=${shape}`], undefined, ENV)).rejects.toThrow('is not an external application')
		const rules = await file('rules.json', {
			app: 'Ops@Tool',
			name: ' Ops',
			resource: 'http://ops.example.com',
			roles: [{ key: 'admin', name: 'Admin' }],
			clients: [{ clientId: 'https://ops.example.com', redirectUris: [], metadataUrl: 'http://doc.example.com' }],
		})
		const refusal = runControlCli('external-apps', ['put', `--file=${rules}`], undefined, ENV)
		await expect(refusal).rejects.toThrow('app must be lowercase')
		await expect(runControlCli('external-apps', ['put', `--file=${rules}`], undefined, ENV)).rejects.toThrow(
			/resource must be[\s\S]*roles\.0\.key[\s\S]*clients\.0\.clientId[\s\S]*clients\.0\.redirectUris[\s\S]*clients\.0\.metadataUrl/,
		)
		await expect(runControlCli('external-apps', ['put', `--file=${join(directory, 'missing.json')}`], undefined, ENV)).rejects.toThrow('No such file')
		expect(sent).toEqual([])
	})

	test('says plainly that IAM takes no registry write before the deploy imported its client list', async () => {
		fakeIam(() => Response.json({ error: { type: 'conflict', message: OAUTH_REGISTRY_NOT_IMPORTED } }, { status: 409 }))
		const path = await file('app.json', APP_FILE)
		await expect(runControlCli('external-apps', ['put', `--file=${path}`], undefined, ENV)).rejects.toThrow(
			'IAM does not take registry writes yet: a platform deploy of this release has not imported the OAuth client list',
		)
	})

	test("passes another refusal on as IAM's answer", async () => {
		fakeIam(() => Response.json({ error: { type: 'forbidden', message: 'not allowed' } }, { status: 403 }))
		await expect(runControlCli('external-apps', ['list'], undefined, ENV)).rejects.toThrow('forbidden: not allowed')
	})
})

describe('control oauth-clients', () => {
	const CLIENT_FILE = {
		clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
		label: 'claude',
		redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
	}
	const STORED_CLIENT = { ...CLIENT_FILE, metadataUrl: null, externalApp: null, createdAt: 1, updatedAt: 2 }

	test('list prints each client with the application it belongs to, or authoring', async () => {
		const sent = fakeIam(
			answering({
				items: [STORED_CLIENT, { ...STORED_CLIENT, clientId: 'https://ops.example.com/c.json', label: 'external', externalApp: 'ops-tool' }],
			}),
		)
		const { stdout } = await capture(() => runControlCli('oauth-clients', ['list'], undefined, ENV))
		expect(sent[0]?.body).toEqual({ method: 'oauthClients.list', input: null })
		expect(stdout.split('\n')).toEqual([
			'https://claude.ai/oauth/mcp-oauth-client-metadata\tclaude\tauthoring\thttps://claude.ai/api/mcp/auth_callback',
			'https://ops.example.com/c.json\texternal\tops-tool\thttps://claude.ai/api/mcp/auth_callback',
		])
	})

	test('put sends the checked file and delete the client id', async () => {
		const sent = fakeIam(answering(STORED_CLIENT))
		const path = await file('client.json', CLIENT_FILE)
		await capture(() => runControlCli('oauth-clients', ['put', `--file=${path}`], undefined, ENV))
		await capture(() => runControlCli('oauth-clients', ['delete', CLIENT_FILE.clientId], undefined, ENV))
		expect(sent.map((call) => call.body)).toEqual([
			{ method: 'oauthClients.put', input: { ...CLIENT_FILE, metadataUrl: null } },
			{ method: 'oauthClients.delete', input: { clientId: CLIENT_FILE.clientId } },
		])
	})

	test('put refuses an unknown label and a client id without a path before any request', async () => {
		const sent = fakeIam(answering(STORED_CLIENT))
		const label = await file('label.json', { ...CLIENT_FILE, label: 'copilot' })
		await expect(runControlCli('oauth-clients', ['put', `--file=${label}`], undefined, ENV)).rejects.toThrow('label:')
		const metadata = await file('metadata.json', { ...CLIENT_FILE, metadataUrl: 'https://user:pw@claude.ai/doc.json' })
		await expect(runControlCli('oauth-clients', ['put', `--file=${metadata}`], undefined, ENV)).rejects.toThrow(
			'metadataUrl must be an https URL without credentials',
		)
		const id = await file('id.json', { ...CLIENT_FILE, clientId: 'https://claude.ai' })
		await expect(runControlCli('oauth-clients', ['put', `--file=${id}`], undefined, ENV)).rejects.toThrow('clientId must be the https URL')
		expect(sent).toEqual([])
	})
})

describe('the registry verbs keep the provisioning key', () => {
	test('need the key from the environment and an https or loopback origin, before any request', async () => {
		const sent = fakeIam(answering({ items: [] }))
		await expect(runControlCli('external-apps', ['list'], undefined, { FABRIKA_IAM_RPC_URL: 'https://iam.example' })).rejects.toThrow(
			'FABRIKA_IAM_PROVISIONING_KEY is required (environment only',
		)
		await expect(runControlCli('oauth-clients', ['list'], undefined, { FABRIKA_IAM_PROVISIONING_KEY: KEY })).rejects.toThrow('IAM origin is required')
		await expect(runControlCli('oauth-clients', ['list', '--iam-url=http://iam.example'], undefined, ENV)).rejects.toThrow('must be https')
		expect(sent).toEqual([])
	})

	test('--iam-url wins over the variable', async () => {
		const sent = fakeIam(answering({ items: [] }))
		await capture(() => runControlCli('oauth-clients', ['list', '--iam-url=http://iam.localhost:8080'], undefined, ENV))
		expect(sent[0]?.url).toBe('http://iam.localhost:8080/admin/rpc')
	})

	test('a redirect is an error, never followed', async () => {
		fakeIam(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/admin/rpc' } }))
		await expect(runControlCli('external-apps', ['list'], undefined, ENV)).rejects.toThrow('HTTP 307: a redirect, which is not followed')
	})

	test('an answer that echoes the key is dropped, and no error carries it', async () => {
		fakeIam(() => Response.json({ error: { type: 'error', message: `bad bearer ${KEY}` } }, { status: 401 }))
		const refusal = await runControlCli('external-apps', ['list'], undefined, ENV).then(() => null, (error: unknown) => error)
		expect(refusal instanceof Error ? refusal.message : '').toBe("transport: IAM's answer carried [FABRIKA_IAM_PROVISIONING_KEY]; it was dropped")
	})

	test('an unreachable IAM names the public origin, not the error object', async () => {
		globalThis.fetch = Object.assign(() => Promise.reject(Object.assign(new Error(`connect ${KEY}`), { code: 'ECONNREFUSED' })), {
			preconnect: realFetch.preconnect,
		})
		const refusal = await runControlCli('external-apps', ['list'], undefined, ENV).then(() => null, (error: unknown) => error)
		const message = refusal instanceof Error ? refusal.message : ''
		expect(message).toContain('IAM could not be reached at https://iam.example (ECONNREFUSED)')
		expect(message).not.toContain(KEY)
	})

	test('the help names both areas and their credentials', () => {
		expect(CONTROL_USAGE).toContain('fabrika control external-apps list | get <app> | put --file=<app.json> | delete <app>')
		expect(CONTROL_USAGE).toContain('fabrika control oauth-clients list | put --file=<client.json> | delete <client id>')
	})
})
