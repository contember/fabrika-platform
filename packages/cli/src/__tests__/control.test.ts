import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROL_USAGE, environmentLine, parseControlFlags, runControlCli, type SecretValueInput } from '../control.js'

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

const captureStderr = async (run: () => Promise<void>): Promise<string> => {
	const lines: string[] = []
	const real = console.warn
	console.warn = (...args: unknown[]) => void lines.push(args.map((arg) => String(arg)).join(' '))
	try {
		await run()
	} finally {
		console.warn = real
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

	test('keeps every value of a repeated option, in order, and the last as its single value', () => {
		const flags = parseControlFlags(['--cross-origin=https://a.example', '--cross-origin=https://b.example'])
		expect(flags.repeated.get('cross-origin')).toEqual(['https://a.example', 'https://b.example'])
		expect(flags.values.get('cross-origin')).toBe('https://b.example')
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

	test('an empty list says so on stderr and prints no data; --json still prints the result', async () => {
		const lists: [string, string[], string][] = [
			['apps', ['list'], 'no applications registered yet'],
			['apps', ['environments', 'list', '--app=notes'], 'app notes has no environments'],
			['apps', ['variables', 'list', '--app=notes'], 'app notes has no variables'],
			['runs', ['list'], 'no runs'],
			['namespaces', ['list'], 'no deployment namespaces yet'],
		]
		for (const [command, argv, message] of lists) {
			captureFetch({ result: { items: [] } })
			let out = ''
			const err = await captureStderr(async () => {
				out = await captureStdout(() => runControlCli(command, argv, undefined, CONTROL_ENV))
			})
			expect({ command: [command, ...argv], out, err }).toEqual({ command: [command, ...argv], out: '', err: message })
			const json = await captureStdout(() => runControlCli(command, [...argv, '--json'], undefined, CONTROL_ENV))
			expect(JSON.parse(json)).toEqual({ items: [] })
		}
	})

	test('a failed run points at its log on stderr', async () => {
		const run = { id: 'r1', appId: 'notes', env: 'prod', status: 'failed', ref: 'refs/heads/main' }
		captureFetch({ result: run })
		let out = ''
		const err = await captureStderr(async () => {
			out = await captureStdout(() => runControlCli('runs', ['get', '--run=r1'], undefined, CONTROL_ENV))
		})
		expect(out).toBe('r1\tnotes\tprod\tfailed\trefs/heads/main')
		expect(err).toBe('why it failed: fabrika control runs log --run=r1')

		captureFetch({ result: { ...run, status: 'succeeded' } })
		expect(await captureStderr(() => runControlCli('runs', ['get', '--run=r1'], undefined, CONTROL_ENV).then(() => {}))).toBe('')
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

describe('control register public origin', () => {
	const NAMESPACE = {
		id: 'ns1',
		env: 'prod',
		state: 'ready',
		hosts: [{ host: 'proxy-8080.prg1.zerops.app', port: 8080 }, { host: 'proxy-8082.prg1.zerops.app', port: 8082 }],
	}
	const REGISTERED = { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } }

	/** Answer each procedure with its own result and record every request body. */
	const routeFetch = (namespace: unknown): unknown[] => {
		const bodies: unknown[] = []
		globalThis.fetch = asFetch(async (_input, init) => {
			const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
			bodies.push(body)
			const result = typeof body === 'object' && body !== null && 'method' in body && body.method === 'namespaces.get' ? namespace : REGISTERED
			return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
		})
		return bodies
	}
	const registerArgs = (extra: string[]): string[] => [
		`--manifest=${import.meta.dir}/fixtures/manifest.json`,
		'--app=notes',
		'--repo=https://github.com/acme/notes',
		'--env=prod',
		'--namespace=ns1',
		'--installation-id=none',
		...extra,
	]

	test('sets https://<domain> when the namespace serves the domain, and says so on stderr', async () => {
		const bodies = routeFetch(NAMESPACE)
		const stderr = await captureStderr(async () => {
			await captureStdout(() => runControlCli('register', registerArgs(['--domain=proxy-8082.prg1.zerops.app']), 'zerops', CONTROL_ENV))
		})
		expect(bodies[0]).toEqual({ method: 'namespaces.get', input: { namespaceId: 'ns1' } })
		expect(bodies[1]).toMatchObject({
			method: 'register',
			input: { domain: 'proxy-8082.prg1.zerops.app', publicOrigin: 'https://proxy-8082.prg1.zerops.app' },
		})
		expect(stderr).toContain('public origin https://proxy-8082.prg1.zerops.app: namespace ns1 serves proxy-8082.prg1.zerops.app')
	})

	test('leaves the origin unset for a domain the namespace does not list, and names the fix', async () => {
		const bodies = routeFetch({ ...NAMESPACE, hosts: undefined })
		const stderr = await captureStderr(async () => {
			await captureStdout(() => runControlCli('register', registerArgs(['--domain=notes.example.com']), 'zerops', CONTROL_ENV))
		})
		expect(bodies[1]).toMatchObject({ method: 'register' })
		expect(JSON.stringify(bodies[1])).not.toContain('publicOrigin')
		expect(stderr).toContain('sign-in cannot return to notes/prod until `apps environments put` sets --public-origin')
	})

	test('register carries every --cross-origin', async () => {
		const bodies = routeFetch(NAMESPACE)
		await captureStderr(async () => {
			await captureStdout(() =>
				runControlCli(
					'register',
					registerArgs(['--domain=proxy-8082.prg1.zerops.app', '--cross-origin=https://a.example', '--cross-origin=https://b.example']),
					'zerops',
					CONTROL_ENV,
				)
			)
		})
		expect(bodies[1]).toMatchObject({ method: 'register', input: { crossOrigins: ['https://a.example', 'https://b.example'] } })
	})

	test('keeps an explicit --public-origin and asks nothing', async () => {
		const bodies = routeFetch(NAMESPACE)
		await captureStdout(() =>
			runControlCli(
				'register',
				registerArgs(['--domain=proxy-8082.prg1.zerops.app', '--public-origin=https://notes.example.com']),
				'zerops',
				CONTROL_ENV,
			)
		)
		expect(bodies).toHaveLength(1)
		expect(bodies[0]).toMatchObject({ method: 'register', input: { publicOrigin: 'https://notes.example.com' } })
	})
})

describe('control apps variables', () => {
	test('put and delete carry the optional environment scope, list omits it', async () => {
		const put = captureFetch({ result: { appId: 'notes', env: 'prod', name: 'FABRIKA_IAM_ISSUER', value: 'https://iam.test' } })
		await captureStdout(() =>
			runControlCli(
				'apps',
				['variables', 'put', '--app=notes', '--env=prod', '--name=FABRIKA_IAM_ISSUER', '--value=https://iam.test'],
				undefined,
				CONTROL_ENV,
			)
		)
		expect(put.calls[0]?.body).toEqual({
			method: 'apps.variables.put',
			input: { appId: 'notes', variable: { name: 'FABRIKA_IAM_ISSUER', value: 'https://iam.test', env: 'prod' } },
		})

		const listed = captureFetch({ result: { items: [] } })
		await captureStdout(() => runControlCli('apps', ['variables', 'list', '--app=notes'], undefined, CONTROL_ENV))
		expect(listed.calls[0]?.body).toEqual({ method: 'apps.variables.list', input: { appId: 'notes' } })

		const removed = captureFetch({ result: { ok: true } })
		await captureStdout(() => runControlCli('apps', ['variables', 'delete', '--app=notes', '--name=OLD'], undefined, CONTROL_ENV))
		expect(removed.calls[0]?.body).toEqual({ method: 'apps.variables.delete', input: { appId: 'notes', name: 'OLD' } })

		await expect(runControlCli('apps', ['variables', 'rotate', '--app=notes'], undefined, CONTROL_ENV)).rejects.toThrow(
			'Unknown `control apps variables` verb: rotate',
		)
	})
})

describe('control apps secrets', () => {
	const SECRET = 'n0t-for-any-log'
	const piped = (text: string): SecretValueInput => ({ isTerminal: () => false, text: () => Promise.resolve(text) })
	const terminal: SecretValueInput = { isTerminal: () => true, text: () => Promise.reject(new Error('a terminal is never read')) }
	const stored = { appId: 'notes', env: 'prod', name: 'API_KEY', storage: 'vault', valueRef: 'vault:01', createdAt: 1 }

	test('put sends the value read from stdin, less one trailing newline, and prints only the scope, name and ok', async () => {
		const put = captureFetch({ result: stored })
		let out = ''
		const err = await captureStderr(async () => {
			out = await captureStdout(() =>
				runControlCli('apps', ['secrets', 'put', '--app=notes', '--env=prod', '--name=API_KEY'], undefined, CONTROL_ENV, piped(`${SECRET}\n`))
			)
		})
		expect(put.calls[0]?.body).toEqual({
			method: 'apps.secrets.put',
			input: { appId: 'notes', secret: { name: 'API_KEY', value: SECRET, env: 'prod' } },
		})
		expect(out).toBe('prod\tAPI_KEY\tok')
		expect(`${out}\n${err}`).not.toContain(SECRET)
	})

	test('put keeps every character but the one final newline', async () => {
		const put = captureFetch({ result: stored })
		await captureStdout(() => runControlCli('apps', ['secrets', 'put', '--app=notes', '--name=API_KEY'], undefined, CONTROL_ENV, piped(' a\nb\n\n')))
		expect(put.calls[0]?.body).toEqual({ method: 'apps.secrets.put', input: { appId: 'notes', secret: { name: 'API_KEY', value: ' a\nb\n' } } })
	})

	test('put refuses a terminal, an empty value and a --value flag before anything is sent', async () => {
		const put = captureFetch({ result: stored })
		const argv = ['secrets', 'put', '--app=notes', '--name=API_KEY']
		await expect(runControlCli('apps', argv, undefined, CONTROL_ENV, terminal)).rejects.toThrow(
			'openssl rand -base64 32 | fabrika control apps secrets put --app=notes --name=API_KEY',
		)
		await expect(runControlCli('apps', argv, undefined, CONTROL_ENV, piped('\n'))).rejects.toThrow('read an empty value from stdin')
		await expect(runControlCli('apps', argv, undefined, CONTROL_ENV, piped(''))).rejects.toThrow('read an empty value from stdin')
		await expect(runControlCli('apps', [...argv, `--value=${SECRET}`], undefined, CONTROL_ENV, piped(SECRET))).rejects.toThrow(
			'takes no --value',
		)
		expect(put.calls).toEqual([])
	})

	test('put cuts the value out of a refusal that quotes it', async () => {
		captureFetch({ error: { type: 'bad_request', message: `refused ${SECRET}` } })
		const message = await runControlCli('apps', ['secrets', 'put', '--app=notes', '--name=API_KEY'], undefined, CONTROL_ENV, piped(SECRET))
			.then(() => 'resolved', (error: unknown) => (error instanceof Error ? error.message : String(error)))
		expect(message).toBe('bad_request: refused [secret value]')
	})

	test('list prints scope, name and storage, never a value or its reference', async () => {
		const listed = captureFetch({ result: { items: [{ ...stored, env: null, name: 'SHARED' }, stored] } })
		const out = await captureStdout(() => runControlCli('apps', ['secrets', 'list', '--app=notes'], undefined, CONTROL_ENV))
		expect(listed.calls[0]?.body).toEqual({ method: 'apps.secrets.list', input: { appId: 'notes' } })
		expect(out).toBe('*\tSHARED\tvault\nprod\tAPI_KEY\tvault')

		captureFetch({ result: { items: [] } })
		const err = await captureStderr(async () => {
			await captureStdout(() => runControlCli('apps', ['secrets', 'list', '--app=notes'], undefined, CONTROL_ENV))
		})
		expect(err).toBe('app notes has no secrets')
	})

	test('delete carries the optional environment scope', async () => {
		const removed = captureFetch({ result: { ok: true } })
		const out = await captureStdout(() =>
			runControlCli('apps', ['secrets', 'delete', '--app=notes', '--env=prod', '--name=FABRIKA_EMAIL_API_KEY'], undefined, CONTROL_ENV)
		)
		expect(removed.calls[0]?.body).toEqual({
			method: 'apps.secrets.delete',
			input: { appId: 'notes', name: 'FABRIKA_EMAIL_API_KEY', env: 'prod' },
		})
		expect(out).toBe('deleted')

		await expect(runControlCli('apps', ['secrets', 'rotate', '--app=notes'], undefined, CONTROL_ENV)).rejects.toThrow(
			'Unknown `control apps secrets` verb: rotate',
		)
	})
})

describe('control apps environments', () => {
	test('put re-registers a changed manifest against an app that already exists', async () => {
		const captured = captureFetch({ result: { appId: 'notes', env: 'prod', provider: 'zerops' } })
		const manifest = `${import.meta.dir}/fixtures/manifest.json`
		await captureStdout(() =>
			runControlCli(
				'apps',
				['environments', 'put', '--app=notes', '--env=prod', `--manifest=${manifest}`, '--namespace=notes-prod'],
				'zerops',
				CONTROL_ENV,
			)
		)
		expect(captured.calls[0]?.body).toEqual({
			method: 'apps.environments.put',
			input: {
				appId: 'notes',
				env: 'prod',
				environment: {
					target: { provider: 'zerops', version: 2, payload: {} },
					artifact: { provider: 'zerops', version: 2, payload: { manifestVersion: 2, app: { id: 'notes' } } },
					namespaceId: 'notes-prod',
				},
			},
		})
	})

	test('a repeated --cross-origin is the whole list, a lone empty one clears it, and none keeps the stored list', async () => {
		const manifest = `${import.meta.dir}/fixtures/manifest.json`
		const put = async (extra: string[]) => {
			const captured = captureFetch({ result: { appId: 'notes', env: 'prod', provider: 'zerops' } })
			await captureStdout(() =>
				runControlCli('apps', ['environments', 'put', '--app=notes', '--env=prod', `--manifest=${manifest}`, ...extra], 'zerops', CONTROL_ENV)
			)
			const body = captured.calls[0]?.body
			return typeof body === 'object' && body !== null && 'input' in body ? body.input : null
		}
		expect(await put(['--cross-origin=https://partner.example.org', '--cross-origin=http://localhost:5173'])).toMatchObject({
			environment: { crossOrigins: ['https://partner.example.org', 'http://localhost:5173'] },
		})
		expect(await put(['--cross-origin='])).toMatchObject({ environment: { crossOrigins: [] } })
		expect(JSON.stringify(await put([]))).not.toContain('crossOrigins')
		await expect(
			runControlCli(
				'apps',
				['environments', 'put', '--app=notes', '--env=prod', `--manifest=${manifest}`, '--cross-origin=', '--cross-origin=https://a.example'],
				'zerops',
				CONTROL_ENV,
			),
		).rejects.toThrow('An empty --cross-origin= clears the list and takes no other --cross-origin')
	})

	test('--kind names the kind of a new environment, and nothing else', async () => {
		const manifest = `${import.meta.dir}/fixtures/manifest.json`
		const captured = captureFetch({ result: { appId: 'notes', env: 'dev', provider: 'zerops' } })
		await captureStdout(() =>
			runControlCli('apps', ['environments', 'put', '--app=notes', '--env=dev', `--manifest=${manifest}`, '--kind=dev'], 'zerops', CONTROL_ENV)
		)
		expect(captured.calls[0]?.body).toMatchObject({ input: { env: 'dev', environment: { kind: 'dev' } } })
		await expect(
			runControlCli('apps', ['environments', 'put', '--app=notes', '--env=dev', `--manifest=${manifest}`, '--kind=preview'], 'zerops', CONTROL_ENV),
		).rejects.toThrow('--kind must be one of standard, dev')
	})

	test('list prints the cross origins of each environment, comma-joined, and - for none', () => {
		const base = { appId: 'notes', env: 'prod', provider: 'zerops', domain: 'notes.example.com' }
		expect(environmentLine({ ...base, crossOrigins: ['https://a.example', 'https://b.example'] })).toBe(
			'notes\tprod\tzerops\tnotes.example.com\thttps://a.example,https://b.example',
		)
		expect(environmentLine({ ...base, domain: null, crossOrigins: [] })).toBe('notes\tprod\tzerops\t-\t-')
		expect(environmentLine(base)).toBe('notes\tprod\tzerops\tnotes.example.com\t-')
	})

	test('list reaches the nested procedure and put still refuses to invent the provider', async () => {
		const captured = captureFetch({ result: { items: [] } })
		await captureStdout(() => runControlCli('apps', ['environments', 'list', '--app=notes'], undefined, CONTROL_ENV))
		expect(captured.calls[0]?.body).toEqual({ method: 'apps.environments.list', input: { appId: 'notes' } })
		await expect(runControlCli('apps', ['environments', 'put', '--app=notes'], undefined, CONTROL_ENV)).rejects.toThrow(
			'--provider=<name> is required',
		)
		await expect(runControlCli('apps', ['environments', 'rename'], undefined, CONTROL_ENV)).rejects.toThrow(
			'Unknown `control apps environments` verb: rename',
		)
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
			runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage,deploy.read'], undefined, ISSUE_ENV)
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

	test('sends an absolute expiry the requested number of seconds ahead', async () => {
		const captured = captureFetch({ ok: true, token: 'px_new', id: 'cred-1' })
		const before = Math.floor(Date.now() / 1000)
		await captureStdout(() => runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
		const expiresAt = Reflect.get(Object(captured.calls[0]?.body), 'expiresAt')
		expect(expiresAt).toBeGreaterThanOrEqual(before + 3600)
		expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600)
	})

	test('refuses a key without an expiry, or one longer than IAM issues, before calling IAM', async () => {
		const captured = captureFetch({ ok: true, token: 'px_new', id: 'cred-1' })
		await expect(runControlCli('key', ['issue', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('--expires-in is required')
		await expect(runControlCli('key', ['issue', '--expires-in=2592001', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('--expires-in must be at most 2592000 seconds')
		expect(captured.calls).toHaveLength(0)
	})

	test('reports a denial as a denial rather than printing an empty token', async () => {
		captureFetch({ ok: false, reason: 'not_allowed' })
		await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('IAM denied the issue request: not_allowed')
	})

	test.each(['missing_token', 'invalid_token', 'unknown_principal', 'disabled', 'not_allowed', 'future_reason', null, 42])(
		'preserves known denial reasons and safely defaults unknown ones: %j',
		async (reason) => {
			captureFetch({ ok: false, reason, token: 'must-not-print' })
			const expected = typeof reason === 'string' && reason !== 'future_reason' ? reason : 'not_allowed'
			await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
				.rejects.toThrow(`IAM denied the issue request: ${expected}`)
		},
	)

	test.each(
		[null, [], {}, { ok: true, token: 1, id: 'cred' }, { ok: true, token: 'secret' }, { ok: 'true', token: 'secret', id: 'cred' }].map(result => ({
			result,
		})),
	)(
		'rejects malformed success responses without exposing their fields: %j',
		async ({ result }) => {
			captureFetch(result)
			await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
				.rejects.toThrow('IAM returned an unreadable issueKey result')
		},
	)

	test.each([null, 12, {}, undefined])('omits malformed optional principal ids from JSON output: %j', async (principalId) => {
		captureFetch({ ok: true, token: '', id: '', principalId, extra: 'private' })
		const out = await captureStdout(() =>
			runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage', '--json'], undefined, ISSUE_ENV)
		)
		expect(JSON.parse(out)).toEqual({ ok: true, token: '', id: '' })
	})

	test('never quotes an upstream body back at the operator', async () => {
		globalThis.fetch = asFetch(async () => new Response('px_leaked_in_an_error_page', { status: 500 }))
		await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('IAM refused the issue request: HTTP 500')
	})

	test('a connection failure names the public origin and the private hostname that cannot serve it', async () => {
		globalThis.fetch = asFetch(() =>
			Promise.reject(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }))
		)
		const failure = await runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, {
			...ISSUE_ENV,
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
		}).then(() => new Error('the run was expected to fail'), (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

		expect(failure.message).toContain('IAM could not be reached at http://iam:3000')
		expect(failure.message).toContain('ConnectionRefused')
		expect(failure.message).toContain("must be IAM's PUBLIC origin")
		expect(failure.message).toContain('answers only inside the provider')
		// The cause object is not passed through: only its short code is quoted.
		expect(failure.message).not.toContain('Is the computer able to access the url?')
		expect(failure.message).not.toContain('rpc-secret')
		expect(failure.message).not.toContain('px_provisioning')
	})

	test('a cause with no usable code still gets the same one-line explanation', async () => {
		globalThis.fetch = asFetch(() => Promise.reject(new Error('px_leaked_in_a_cause')))
		await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, ISSUE_ENV))
			.rejects.toThrow('IAM could not be reached at https://iam.example (the connection failed)')
	})

	test('names the parsed origin only, so userinfo in the value is not echoed back', async () => {
		globalThis.fetch = asFetch(() => Promise.reject(Object.assign(new Error('nope'), { code: 'ConnectionRefused' })))
		const failure = await runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, {
			...ISSUE_ENV,
			FABRIKA_IAM_RPC_URL: 'https://operator:px_in_the_url@iam.example',
		}).then(() => new Error('the run was expected to fail'), (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

		expect(failure.message).toContain('IAM could not be reached at https://iam.example')
		expect(failure.message).not.toContain('px_in_the_url')
		expect(failure.message).not.toContain('operator:')
	})

	test('a value with no scheme is reported as not a URL, not as the wrong kind of host', async () => {
		globalThis.fetch = asFetch(() => Promise.reject(Object.assign(new TypeError('fetch() URL is invalid'), { code: 'ERR_INVALID_URL' })))
		const failure = await runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, {
			...ISSUE_ENV,
			FABRIKA_IAM_RPC_URL: 'iam-with-no-scheme.invalid',
		}).then(() => new Error('the run was expected to fail'), (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))

		expect(failure.message).toContain('is not a URL')
		expect(failure.message).toContain('it needs the `https://` scheme')
		// The advice for a private hostname would be wrong here, and the unparsed value is not echoed.
		expect(failure.message).not.toContain('http://iam:3000')
		expect(failure.message).not.toContain('iam-with-no-scheme.invalid')
	})

	test('a missing origin on this path names the IAM variable, not the control one', async () => {
		await expect(runControlCli('key', ['issue', '--expires-in=3600', '--label=agent', '--permissions=app.manage'], undefined, {
			FABRIKA_IAM_RPC_KEY: 'rpc-secret',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		})).rejects.toThrow('IAM origin is required. Pass --iam-url=<origin> or set FABRIKA_IAM_RPC_URL.')
	})
})

describe('control --help', () => {
	test('names LIGHT as the core-package default on every environment (ADR-0038)', () => {
		expect(CONTROL_USAGE).toContain('--core-package=<LIGHT|SERIOUS>    defaults to LIGHT on every environment')
		expect(CONTROL_USAGE).not.toContain('defaults to SERIOUS')
	})

	test('names the PUBLIC origin for FABRIKA_IAM_RPC_URL and says what is not one', () => {
		expect(CONTROL_USAGE).toContain("FABRIKA_IAM_RPC_URL               required   IAM's PUBLIC origin, or --iam-url")
		expect(CONTROL_USAGE).not.toContain("IAM's own origin")
		expect(CONTROL_USAGE).toContain('http://iam:3000')
	})
})

/** A whole `namespaces.plan` result, shaped as the Zerops provider answers one. */
const zeropsPlan = (payload: Record<string, unknown>, exclusiveAppId?: string) => ({
	namespace: {
		id: 'notes-prod',
		env: 'prod',
		...(exclusiveAppId === undefined ? {} : { exclusiveAppId }),
		target: { provider: 'zerops', version: 1, payload },
	},
	presentation: { preset: 'mid', title: 'Mid namespace', facts: [], instructions: [] },
})

describe('control namespaces', () => {
	test('plan sends only the placement options actually given', async () => {
		const captured = captureFetch({ result: zeropsPlan({ corePackage: 'LIGHT' }) })
		await captureStdout(() =>
			runControlCli('namespaces', ['plan', '--namespace=notes-prod', '--env=prod', '--preset=mid', '--core-package=LIGHT'], undefined, CONTROL_ENV)
		)
		expect(captured.calls[0]?.body).toEqual({
			method: 'namespaces.plan',
			input: { id: 'notes-prod', env: 'prod', preset: 'mid', options: { corePackage: 'LIGHT' } },
		})
	})

	test('plan forwards the shared PostgreSQL type and profile, and refuses a profile without a type', async () => {
		const captured = captureFetch({ result: zeropsPlan({ corePackage: 'LIGHT' }) })
		await captureStdout(() =>
			runControlCli(
				'namespaces',
				['plan', '--namespace=notes-prod', '--env=prod', '--preset=cheap', '--postgres-type=postgresql:ha@18', '--postgres-profile=oltp-staging'],
				undefined,
				CONTROL_ENV,
			)
		)
		expect(captured.calls[0]?.body).toEqual({
			method: 'namespaces.plan',
			input: { id: 'notes-prod', env: 'prod', preset: 'cheap', options: { postgres: { type: 'postgresql:ha@18', profile: 'oltp-staging' } } },
		})
		await expect(
			runControlCli(
				'namespaces',
				['plan', '--namespace=notes-prod', '--env=prod', '--preset=cheap', '--postgres-profile=oltp-staging'],
				undefined,
				CONTROL_ENV,
			),
		).rejects.toThrow('--postgres-type and --postgres-profile go together')
		await expect(
			runControlCli(
				'namespaces',
				['plan', '--namespace=notes-prod', '--env=prod', '--preset=cheap', '--postgres-type=postgresql:ha@18'],
				undefined,
				CONTROL_ENV,
			),
		).rejects.toThrow('--postgres-type and --postgres-profile go together')
	})

	test('create commits the plan it just read rather than deriving a second one', async () => {
		const calls: Captured[] = []
		globalThis.fetch = asFetch(async (input, init) => {
			const raw = init?.body
			const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
			calls.push({ url: String(input), authorization: null, body })
			const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : null
			const result = method === 'namespaces.plan'
				? { namespace: { target: { provider: 'zerops', version: 1, payload: { projectName: 'fabrika-notes-prod' } } } }
				: { id: 'notes-prod', env: 'prod', state: 'ready', exclusiveAppId: null }
			return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } })
		})
		await captureStdout(() => runControlCli('namespaces', ['create', '--namespace=notes-prod', '--env=prod', '--preset=mid'], undefined, CONTROL_ENV))
		expect(calls).toHaveLength(2)
		expect(calls[1]?.body).toEqual({
			method: 'namespaces.create',
			input: { id: 'notes-prod', env: 'prod', target: { provider: 'zerops', version: 1, payload: { projectName: 'fabrika-notes-prod' } } },
		})
	})

	test('reconcile resumes one namespace by id instead of planning a second', async () => {
		const captured = captureFetch({ result: { id: 'notes-prod', env: 'prod', state: 'ready', exclusiveAppId: null } })
		const out = await captureStdout(() => runControlCli('namespaces', ['reconcile', '--namespace=notes-prod'], undefined, CONTROL_ENV))
		expect(captured.calls).toHaveLength(1)
		expect(captured.calls[0]?.body).toEqual({ method: 'namespaces.reconcile', input: { namespaceId: 'notes-prod' } })
		expect(out).toBe('notes-prod\tprod\tready\t-')
	})

	test('update --proxy-source=current re-pins the placement through namespaces.update, in its own target envelope', async () => {
		const target = { provider: 'zerops', version: 1, payload: {} }
		const captured = captureFetch({ result: { id: 'notes-prod', env: 'prod', state: 'pending', exclusiveAppId: null, target } })
		const out = await captureStdout(() =>
			runControlCli('namespaces', ['update', '--namespace=notes-prod', '--proxy-source=current'], undefined, CONTROL_ENV)
		)
		expect(captured.calls.map((call) => call.body)).toEqual([
			{ method: 'namespaces.get', input: { namespaceId: 'notes-prod' } },
			{
				method: 'namespaces.update',
				input: { namespaceId: 'notes-prod', namespace: { target: { provider: 'zerops', version: 1, payload: { proxySource: 'current' } } } },
			},
		])
		expect(out).toBe('notes-prod\tprod\tpending\t-')
		await expect(runControlCli('namespaces', ['update', '--namespace=notes-prod', '--proxy-source=abc'], undefined, CONTROL_ENV)).rejects
			.toThrow('--proxy-source takes only `current`')
	})

	test('get reports the failure class on stderr and leaves the data columns alone', async () => {
		const captured = captureFetch({
			result: {
				id: 'notes-prod',
				env: 'prod',
				state: 'failed',
				exclusiveAppId: null,
				lastError: 'zerops: project import failed (403) — client may not create projects',
				lastErrorCode: 'insufficientPermissions',
			},
		})
		let out = ''
		const err = await captureStderr(async () => {
			out = await captureStdout(() => runControlCli('namespaces', ['get', '--namespace=notes-prod'], undefined, CONTROL_ENV))
		})

		expect(captured.calls[0]?.body).toEqual({ method: 'namespaces.get', input: { namespaceId: 'notes-prod' } })
		expect(out).toBe('notes-prod\tprod\tfailed\t-')
		expect(err).toBe([
			'insufficientPermissions: zerops: project import failed (403) — client may not create projects',
			'resume it with: fabrika control namespaces reconcile --namespace=notes-prod',
		].join('\n'))
	})

	test('get names no reconcile for an unconfirmed update, which only retrying the update clears', async () => {
		captureFetch({
			result: {
				id: 'notes-prod',
				env: 'prod',
				state: 'failed',
				exclusiveAppId: null,
				lastError: 'an update started and is not confirmed — retry namespaces.update with the planned target in unconfirmedTarget',
				lastErrorCode: 'namespaceUpdateUnconfirmed',
				unconfirmedTarget: { provider: 'zerops', version: 1, payload: {} },
			},
		})
		const err = await captureStderr(() => runControlCli('namespaces', ['get', '--namespace=notes-prod'], undefined, CONTROL_ENV).then(() => {}))

		expect(err).not.toContain('reconcile --namespace')
	})

	test('remove frees the id and names the provider resources it did not delete', async () => {
		const captured = captureFetch({
			result: {
				removed: {
					id: 'notes-prod',
					env: 'prod',
					state: 'failed',
					exclusiveAppId: null,
					lastError: 'zerops: project import failed (403)',
					lastErrorCode: 'insufficientPermissions',
					target: { provider: 'zerops', version: 1, payload: { projectId: 'project-1' } },
					presentation: {
						preset: 'mid',
						title: 'Mid namespace',
						facts: [
							{ label: 'Project', value: 'notes-prod (project-1)', resource: true },
							{ label: 'Environment', value: 'prod' },
							{ label: 'Core package', value: 'LIGHT' },
						],
						instructions: [],
					},
				},
			},
		})
		let out = ''
		const err = await captureStderr(async () => {
			out = await captureStdout(() => runControlCli('namespaces', ['remove', '--namespace=notes-prod'], undefined, CONTROL_ENV))
		})

		expect(captured.calls[0]?.body).toEqual({ method: 'namespaces.remove', input: { namespaceId: 'notes-prod' } })
		expect(out).toBe('notes-prod\tprod\tfailed\t-')
		// Only the facts the provider marked as live resources; the policy facts are not anyone's cleanup.
		expect(err).toBe('retained\tProject\tnotes-prod (project-1)')
	})

	test('carries an exclusive app through both calls for the full preset', async () => {
		const captured = captureFetch({ result: zeropsPlan({}, 'notes') })
		await captureStdout(() =>
			runControlCli('namespaces', ['plan', '--namespace=notes-prod', '--env=prod', '--preset=full', '--exclusive-app=notes'], undefined, CONTROL_ENV)
		)
		expect(captured.calls[0]?.body).toMatchObject({ input: { exclusiveAppId: 'notes' } })
	})

	const DESCRIPTOR = 'zerops:\n  - setup: proxy\n    run:\n      start: caddy run\n'
	const cheapPlan = {
		namespace: {
			id: 'apps',
			env: 'v03',
			target: {
				provider: 'zerops',
				version: 1,
				payload: {
					proxySource: {
						repository: { owner: 'acme', name: 'fabrika-proxy' },
						commitSha: 'abc123',
						descriptor: { path: 'zerops.yaml', contents: DESCRIPTOR, sha256: 'f00d' },
					},
					projectName: 'apps',
					corePackage: 'LIGHT',
					publicAccess: 'zerops-subdomain',
					postgres: { type: 'postgresql:single@18', profile: 'oltp-staging' },
					managed: true,
					ready: false,
					proxyHosts: [],
				},
			},
		},
		presentation: {
			preset: 'cheap',
			title: 'Cheap namespace',
			facts: [
				{ label: 'Project', value: 'apps' },
				{ label: 'PostgreSQL', value: 'Shared postgresql:single@18 (oltp-staging)' },
			],
			instructions: ['Use the proxy Zerops subdomain only for non-production access; app services must remain private.'],
		},
	}

	test('plan never lets a tab or a line break inside a value split a row', async () => {
		const tabbed = { ...cheapPlan, presentation: { ...cheapPlan.presentation, facts: [{ label: 'Note', value: 'a\tb' }], instructions: ['one\rtwo'] } }
		captureFetch({ result: tabbed })
		const out = await captureStdout(() =>
			runControlCli('namespaces', ['plan', '--namespace=apps', '--env=v03', '--preset=cheap'], undefined, CONTROL_ENV)
		)
		expect(out).toContain('presentation.fact\tNote\t(3 bytes; --json prints it)')
		expect(out).toContain('presentation.instruction\t(7 bytes; --json prints it)')
	})

	test('plan prints one row per field and names the descriptor file by size, never by contents', async () => {
		captureFetch({ result: cheapPlan })
		const out = await captureStdout(() =>
			runControlCli('namespaces', ['plan', '--namespace=apps', '--env=v03', '--preset=cheap'], undefined, CONTROL_ENV)
		)

		expect(out.split('\n')).toEqual([
			'namespace.id\tapps',
			'namespace.env\tv03',
			'namespace.exclusiveAppId\t-',
			'namespace.target.provider\tzerops',
			'namespace.target.version\t1',
			'namespace.target.payload.proxySource.repository.owner\tacme',
			'namespace.target.payload.proxySource.repository.name\tfabrika-proxy',
			'namespace.target.payload.proxySource.commitSha\tabc123',
			'namespace.target.payload.proxySource.descriptor.path\tzerops.yaml',
			`namespace.target.payload.proxySource.descriptor.contents\t(${DESCRIPTOR.length} bytes; --json prints it)`,
			'namespace.target.payload.proxySource.descriptor.sha256\tf00d',
			'namespace.target.payload.projectName\tapps',
			'namespace.target.payload.corePackage\tLIGHT',
			'namespace.target.payload.publicAccess\tzerops-subdomain',
			'namespace.target.payload.postgres.type\tpostgresql:single@18',
			'namespace.target.payload.postgres.profile\toltp-staging',
			'namespace.target.payload.managed\ttrue',
			'namespace.target.payload.ready\tfalse',
			'namespace.target.payload.proxyHosts\t[]',
			'presentation.preset\tcheap',
			'presentation.title\tCheap namespace',
			'presentation.fact\tProject\tapps',
			'presentation.fact\tPostgreSQL\tShared postgresql:single@18 (oltp-staging)',
			'presentation.instruction\tUse the proxy Zerops subdomain only for non-production access; app services must remain private.',
		])
		expect(out).not.toContain('caddy run')
	})

	test('plan --json still prints the procedure result verbatim', async () => {
		captureFetch({ result: cheapPlan })
		const out = await captureStdout(() =>
			runControlCli('namespaces', ['plan', '--namespace=apps', '--env=v03', '--preset=cheap', '--json'], undefined, CONTROL_ENV)
		)

		expect(out).toBe(JSON.stringify(cheapPlan, null, 2))
	})
})

describe('control register source binding', () => {
	const registerArgs = (extra: string[]): string[] => [
		`--manifest=${import.meta.dir}/fixtures/manifest.json`,
		'--app=notes',
		'--repo=https://github.com/acme/notes',
		'--env=prod',
		...extra,
	]

	test('carries nested JSON extensions through registration without normalizing their values', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-cli-manifest-'))
		try {
			const manifest = { manifestVersion: 3, extension: [null, true, 1.5, '  text  ', { enabled: false, nested: [] }] }
			const path = join(directory, 'manifest.json')
			await Bun.write(path, JSON.stringify(manifest))
			const captured = captureFetch({ result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } })
			await captureStdout(() => runControlCli('register', registerArgs([`--manifest=${path}`]), 'zerops', CONTROL_ENV))
			expect(captured.calls[0]?.body).toMatchObject({ input: { artifact: { provider: 'zerops', version: 3, payload: manifest } } })
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test.each(['null', '[]', '{"manifestVersion":"3"}', '{"manifestVersion":0}', '{"manifestVersion":1.5}', '{"manifestVersion":9007199254740992}'])(
		'rejects invalid manifest headers before making a request: %s',
		async (text) => {
			const directory = await mkdtemp(join(tmpdir(), 'fabrika-cli-manifest-'))
			try {
				const path = join(directory, 'manifest.json')
				await Bun.write(path, text)
				const captured = captureFetch({})
				await expect(runControlCli('register', registerArgs([`--manifest=${path}`]), 'zerops', CONTROL_ENV))
					.rejects.toThrow(`${path} declares no manifestVersion — run \`fabrika app build\` to produce one`)
				expect(captured.calls).toEqual([])
			} finally {
				await rm(directory, { recursive: true, force: true })
			}
		},
	)

	test('keeps syntax and missing-file diagnostics distinct', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-cli-manifest-'))
		try {
			const path = join(directory, 'manifest.json')
			await expect(runControlCli('register', registerArgs([`--manifest=${path}`]), 'zerops', CONTROL_ENV))
				.rejects.toThrow(`No such file: ${path}`)
			await Bun.write(path, '{')
			await expect(runControlCli('register', registerArgs([`--manifest=${path}`]), 'zerops', CONTROL_ENV))
				.rejects.toThrow(`${path} is not valid JSON`)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('--installation-id=none registers the anonymous public-repository source', async () => {
		const captured = captureFetch({ result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } })
		await captureStdout(() => runControlCli('register', registerArgs(['--installation-id=none']), 'zerops', CONTROL_ENV))
		expect(captured.calls[0]?.body).toMatchObject({ input: { githubInstallationId: null } })
	})

	test('takes the envelope version from the manifest rather than a literal', async () => {
		const captured = captureFetch({ result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } })
		await captureStdout(() =>
			runControlCli(
				'register',
				registerArgs(['--installation-id=none', `--manifest=${import.meta.dir}/fixtures/manifest-v3.json`]),
				'zerops',
				CONTROL_ENV,
			)
		)
		expect(captured.calls[0]?.body).toMatchObject({
			input: { artifact: { version: 3 }, target: { version: 3 } },
		})
	})

	test('refuses a file that is not a built manifest', async () => {
		await expect(
			runControlCli(
				'register',
				registerArgs(['--installation-id=none', `--manifest=${import.meta.dir}/fixtures/not-a-manifest.json`]),
				'zerops',
				CONTROL_ENV,
			),
		).rejects.toThrow('declares no manifestVersion')
	})

	test('a numeric --installation-id names one installation outright', async () => {
		const captured = captureFetch({ result: { app: { id: 'notes' }, env: { env: 'prod', provider: 'zerops' } } })
		await captureStdout(() => runControlCli('register', registerArgs(['--installation-id=154387356']), 'zerops', CONTROL_ENV))
		expect(captured.calls[0]?.body).toMatchObject({ input: { githubInstallationId: 154387356 } })
	})
})
