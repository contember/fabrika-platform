import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROL_USAGE, parseControlFlags, runControlCli } from '../control.js'

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
		expect(err).toBe('insufficientPermissions: zerops: project import failed (403) — client may not create projects')
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
