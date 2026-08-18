import { afterEach, describe, expect, test } from 'bun:test'
import { parseControlFlags, runControlCli } from '../control.js'

const CONTROL_ENV = { FABRIKA_CONTROL_URL: 'https://control.example', FABRIKA_CONTROL_KEY: 'px_test' } as const

interface Captured {
	readonly url: string
	readonly authorization: string | null
	readonly body: unknown
}

const realFetch = globalThis.fetch

/** Bun's `fetch` carries `preconnect`, so a stub must too — and borrowing the real one beats a cast. */
const asFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
	Object.assign(handler, { preconnect: realFetch.preconnect })

/** Answer every request with one RPC envelope and record what the client sent. */
const captureFetch = (result: unknown): { calls: Captured[] } => {
	const calls: Captured[] = []
	globalThis.fetch = asFetch(async (input, init) => {
		const headers = new Headers(init?.headers)
		const raw = init?.body
		calls.push({
			url: String(input),
			authorization: headers.get('authorization'),
			body: typeof raw === 'string' ? JSON.parse(raw) : null,
		})
		return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
	})
	return { calls }
}

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
	const lines: string[] = []
	const real = console.info
	console.info = (...args: unknown[]) => void lines.push(args.map((arg) => String(arg)).join(' '))
	try {
		await run()
	} finally {
		console.info = real
	}
	return lines.join('\n')
}

afterEach(() => {
	globalThis.fetch = realFetch
})

describe('control flag parsing', () => {
	test('splits options, the shared --json flag, and positional verbs', () => {
		const flags = parseControlFlags(['list', '--app=notes', '--json'])
		expect(flags.positional).toEqual(['list'])
		expect(flags.values.get('app')).toBe('notes')
		expect(flags.json).toBe(true)
	})

	test('refuses an option with no value rather than guessing one', () => {
		expect(() => parseControlFlags(['--app'])).toThrow('Option --app needs a value')
	})
})

describe('control credential handling', () => {
	test('requires the control key from the environment, never from a flag', async () => {
		await expect(runControlCli('apps', ['list'], undefined, { FABRIKA_CONTROL_URL: 'https://control.example' }))
			.rejects.toThrow('FABRIKA_CONTROL_KEY is required')
	})

	test('requires an origin and names both ways to give one', async () => {
		await expect(runControlCli('apps', ['list'], undefined, { FABRIKA_CONTROL_KEY: 'px_test' }))
			.rejects.toThrow('FABRIKA_CONTROL_URL')
	})

	test("sends the key as a bearer to the console's own RPC path", async () => {
		const captured = captureFetch({ result: { items: [] } })
		await captureStdout(() => runControlCli('apps', ['list'], undefined, CONTROL_ENV))
		expect(captured.calls).toHaveLength(1)
		expect(captured.calls[0]?.url).toBe('https://control.example/api/rpc')
		expect(captured.calls[0]?.authorization).toBe('Bearer px_test')
	})

	test('drops a trailing slash so the path concatenates once', async () => {
		const captured = captureFetch({ result: { items: [] } })
		await captureStdout(() => runControlCli('apps', ['list'], undefined, { ...CONTROL_ENV, FABRIKA_CONTROL_URL: 'https://control.example/' }))
		expect(captured.calls[0]?.url).toBe('https://control.example/api/rpc')
	})
})

describe('control output contract', () => {
	test('--json prints the procedure result verbatim', async () => {
		captureFetch({ result: { items: [{ id: 'notes', repoUrl: 'https://github.com/acme/notes', defaultBranch: 'main' }] } })
		const out = await captureStdout(() => runControlCli('apps', ['list', '--json'], undefined, CONTROL_ENV))
		expect(JSON.parse(out)).toEqual({ items: [{ id: 'notes', repoUrl: 'https://github.com/acme/notes', defaultBranch: 'main' }] })
	})

	test('a run log prints its lines and nothing else', async () => {
		captureFetch({ result: { lines: [{ ts: 1, stream: 'stdout', text: 'building' }, { ts: 2, stream: 'stdout', text: 'done' }] } })
		const out = await captureStdout(() => runControlCli('runs', ['log', '--run=r1'], undefined, CONTROL_ENV))
		expect(out).toBe('building\ndone')
	})

	test('an RPC denial keeps its type so a caller can tell it from an outage', async () => {
		globalThis.fetch = asFetch(async () =>
			new Response(JSON.stringify({ error: { type: 'forbidden', message: 'deploy.trigger required' } }), {
				status: 403,
				headers: { 'content-type': 'application/json' },
			})
		)
		await expect(runControlCli('deploy', ['--app=notes', '--env=prod'], undefined, CONTROL_ENV))
			.rejects.toThrow('forbidden: deploy.trigger required')
	})
})

describe('control register', () => {
	test('carries the manifest as the artifact envelope and defaults to resolving the installation', async () => {
		const captured = captureFetch({ result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } })
		const manifest = `${import.meta.dir}/fixtures/manifest.json`
		await captureStdout(() =>
			runControlCli(
				'register',
				[
					`--manifest=${manifest}`,
					'--app=notes',
					'--repo=https://github.com/acme/notes',
					'--env=prod',
				],
				'zerops',
				CONTROL_ENV,
			)
		)
		const body = captured.calls[0]?.body
		expect(body).toEqual({
			method: 'register',
			input: {
				id: 'notes',
				repoUrl: 'https://github.com/acme/notes',
				env: 'prod',
				target: { provider: 'zerops', version: 2, payload: {} },
				artifact: { provider: 'zerops', version: 2, payload: { manifestVersion: 2, app: { id: 'notes' } } },
				resolveInstallationId: true,
			},
		})
	})

	test('refuses to invent the envelope provider', async () => {
		await expect(runControlCli('register', ['--app=notes'], undefined, CONTROL_ENV)).rejects.toThrow('--provider=<name> is required')
	})
})

describe('control routing', () => {
	test('rejects an unknown group and an unknown verb separately', async () => {
		await expect(runControlCli('sources', [], undefined, CONTROL_ENV)).rejects.toThrow('Unknown control command: sources')
		await expect(runControlCli('runs', ['follow'], undefined, CONTROL_ENV)).rejects.toThrow('Unknown `control runs` verb: follow')
	})

	test('key issue is the only `key` verb', async () => {
		await expect(runControlCli('key', ['rotate'], undefined, CONTROL_ENV)).rejects.toThrow('Unknown `control key` verb: rotate')
	})
})

describe('control key issue', () => {
	const ISSUE_ENV = {
		FABRIKA_IAM_RPC_URL: 'https://iam.example',
		FABRIKA_IAM_RPC_KEY: 'rpc-secret',
		FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
	} as const

	test('issues against IAM with the provisioning key as the ISSUER credential', async () => {
		const captured = captureFetch({ ok: true, token: 'px_new', id: 'cred-1', principalId: 'prin-1' })
		const out = await captureStdout(() =>
			runControlCli('key', ['issue', '--label=agent', '--permissions=app.manage,deploy.read'], undefined, ISSUE_ENV)
		)
		expect(out).toBe('px_new')
		expect(captured.calls[0]?.url).toBe('https://iam.example/rpc/issueKey')
		expect(captured.calls[0]?.authorization).toBe('Bearer rpc-secret')
		const body = captured.calls[0]?.body
		expect(body).toMatchObject({
			app: 'vozka',
			credential: 'px_provisioning',
			service: { label: 'agent', permissions: ['app.manage', 'deploy.read'] },
		})
	})

	test('reports a denial as a denial rather than printing an empty token', async () => {
		captureFetch({ ok: false, reason: 'not_allowed' })
		await expect(runControlCli('key', ['issue', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('IAM denied the issue request: not_allowed')
	})

	test('never quotes an upstream body back at the operator', async () => {
		globalThis.fetch = asFetch(async () => new Response('px_leaked_in_an_error_page', { status: 500 }))
		await expect(runControlCli('key', ['issue', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('IAM refused the issue request: HTTP 500')
	})
})
