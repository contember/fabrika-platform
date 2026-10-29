import { createZeropsArtifactSourceDescriptor, type ZeropsSourceUploadInput } from '@fabrika/provider-zerops'
import { describe, expect, spyOn, test } from 'bun:test'
import { controlMcpSwitch, controlServiceDigest, ControlTableError } from '../../fabrika.service'
import type { Env } from '../env'
import { ZEROPS_MAIL_REMEDY } from '../mail-transport'
import { buildControlRpcDeps, buildRunDeps } from '../services'
import { isZeropsSandboxFileDestination, zeropsControlProvider, zeropsGitHubSources, zeropsNamespaceProcessConfig } from '../zerops/provider'
import { createRuntime } from '../zerops/runtime'
import { createHarness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'

const PIN = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: { ...await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n') },
}
const namespaceEnvironment = (): Record<string, string | undefined> => ({
	FABRIKA_ZEROPS_CLIENT_ID: 'client-1',
	FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify(PIN),
	FABRIKA_ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
	FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
	FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: false }),
})

/** What Control's process needs to boot, without the mail transport. */
const controlEnvironment = (): Record<string, string | undefined> => ({
	...namespaceEnvironment(),
	FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
	FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
	FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
	FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
	FABRIKA_IAM_RPC_URL: 'http://iam:3000',
	FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
	FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
	ENVIRONMENT: 'stage',
})

const EXPECTED = {
	clientId: 'client-1',
	proxySource: PIN,
	iamUrl: 'https://iam.example.test',
	iamKey: 'px_proxy_placeholder',
}

describe('the Zerops namespace process configuration', () => {
	test('refuses malformed JSON without exposing its value and requires the variable', () => {
		const env = { ...namespaceEnvironment(), FABRIKA_ZEROPS_PROXY_SOURCE_JSON: 'credential-that-must-not-leak' }
		expect(() => zeropsNamespaceProcessConfig(env)).toThrow('must contain a valid immutable proxy source')
		expect(() => zeropsNamespaceProcessConfig({ ...env, FABRIKA_ZEROPS_PROXY_SOURCE_JSON: undefined })).toThrow(
			'FABRIKA_ZEROPS_PROXY_SOURCE_JSON is required',
		)
	})
	test('boots with no source service, and administers GitHub connections in process', async () => {
		const runtime = createRuntime({
			...namespaceEnvironment(),
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			ENVIRONMENT: 'stage',
		})
		expect(runtime.sourceConnection).toMatchObject({ provider: 'zerops' })
		expect(runtime.provider.source).toEqual({ binding: 'connection' })
		await runtime.shutdown()
	})

	test("hands the installation's mail transport from its own environment to every deploy", async () => {
		const runtime = createRuntime({
			...namespaceEnvironment(),
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			ENVIRONMENT: 'stage',
			FABRIKA_EMAIL_PROVIDER: 'resend',
			FABRIKA_EMAIL_FROM: 'mail@example.test',
			FABRIKA_EMAIL_RESEND_API_KEY: 're_key',
		})
		try {
			const deps = await buildRunDeps(runtime.env, runtime.provider)
			expect(deps.mailTransport).toEqual({
				kind: 'transport',
				transport: {
					variables: { FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_FROM: 'mail@example.test', FABRIKA_EMAIL_RESEND_API_KEY: 're_key' },
					secretNames: new Set(['FABRIKA_EMAIL_RESEND_API_KEY']),
				},
			})
		} finally {
			await runtime.shutdown()
		}
	})

	test("hands every deploy Control's public origin for the relay, from the bare host an installation writes", async () => {
		for (const [domain, origin] of [['proxy-abc.prg1.zerops.app', 'https://proxy-abc.prg1.zerops.app'], [undefined, undefined]]) {
			const runtime = createRuntime({ ...controlEnvironment(), FABRIKA_CONTROL_DOMAIN: domain })
			try {
				expect((await buildRunDeps(runtime.env, runtime.provider)).controlOrigin).toBe(origin)
			} finally {
				await runtime.shutdown()
			}
		}
	})

	test('an invalid FABRIKA_EMAIL_* keeps Control up, and the warning names the variable, never its value', async () => {
		const warnings: string[] = []
		const warn = spyOn(console, 'warn').mockImplementation((line: unknown) => {
			warnings.push(String(line))
		})
		try {
			const runtime = createRuntime({
				...controlEnvironment(),
				FABRIKA_EMAIL_PROVIDER: 'smartemailing',
				FABRIKA_EMAIL_FROM: 'mail@example.test',
				FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se-private-key',
			})
			expect(runtime.env.MAIL_TRANSPORT).toEqual({
				kind: 'invalid',
				reason: expect.stringContaining('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing'),
				remedy: ZEROPS_MAIL_REMEDY,
			})
			await runtime.shutdown()
		} finally {
			warn.mockRestore()
		}
		expect(warnings.join('\n')).toContain('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing')
		expect(warnings.join('\n')).not.toContain('se-private-key')
	})

	test('no FABRIKA_EMAIL_* at all, as on an installation from before the transport, reads as none', async () => {
		const runtime = createRuntime(controlEnvironment())
		expect(runtime.env.MAIL_TRANSPORT).toEqual({ kind: 'none' })
		await runtime.shutdown()
	})

	test('the process provider republishes namespaces, so the registry hook is wired from its capability', async () => {
		const runtime = createRuntime({
			...namespaceEnvironment(),
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			ENVIRONMENT: 'stage',
		})
		const deps = buildControlRpcDeps(runtime.env, runtime.provider, allowAllAuth())
		// Addressed by namespace id alone, and a namespace it cannot read is a refusal, never a silent no-op.
		expect(typeof deps.namespaceProxyChanged).toBe('function')
		await expect(deps.namespaceProxyChanged?.('nope')).rejects.toThrow()
		await runtime.shutdown()
	})

	test('maps every explicit environment variable to the provider contract', () => {
		expect(zeropsNamespaceProcessConfig(namespaceEnvironment())).toEqual(EXPECTED)
	})

	test('reads the installation project id when platform deploy has written it, and starts without it', () => {
		expect(zeropsNamespaceProcessConfig({ ...namespaceEnvironment(), FABRIKA_ZEROPS_PLATFORM_PROJECT_ID: 'proj-platform' })).toEqual({
			...EXPECTED,
			installationProjectId: 'proj-platform',
		})
		expect(zeropsNamespaceProcessConfig({ ...namespaceEnvironment(), FABRIKA_ZEROPS_PLATFORM_PROJECT_ID: '' })).toEqual(EXPECTED)
	})

	test('enables namespace lifecycle on the composed provider', () => {
		const harness = createHarness()
		const env: Env = {
			DB: harness.d1,
			REPOSITORIES: harness.repositories,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: {
				put: () => Promise.resolve(),
				get: () => Promise.resolve(null),
				delete: () => Promise.resolve(),
			},
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'prod',
		}
		const provider = zeropsControlProvider({
			...namespaceEnvironment(),
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		}, zeropsGitHubSources(env).port)

		if (provider.namespaces === undefined) {
			throw new Error('Zerops provider did not enable namespace capabilities')
		}
		const normalized = provider.namespaces.normalize({
			id: 'apps-prod',
			env: 'prod',
			target: { provider: 'zerops', version: 1, payload: { proxySource: PIN } },
		})
		expect(normalized.target.payload).toEqual({
			projectName: 'apps-prod',
			corePackage: 'LIGHT',
			publicAccess: 'custom-domain',
			proxySource: PIN,
			managed: true,
			ready: false,
		})
		harness.sqlite.close()
	})

	for (
		const name of [
			'FABRIKA_ZEROPS_CLIENT_ID',
			'FABRIKA_ZEROPS_PROXY_SOURCE_JSON',
			'FABRIKA_ZEROPS_PROXY_IAM_URL',
			'FABRIKA_ZEROPS_PROXY_IAM_KEY',
		]
	) {
		test(`${name} is explicit and required`, () => {
			const source = namespaceEnvironment()
			source[name] = ' '
			expect(() => zeropsNamespaceProcessConfig(source)).toThrow(`${name} is required by the Zerops provider`)
		})
	}
})

describe('the one MCP switch: the table the proxy publishes', () => {
	const process = (overrides: Record<string, string | undefined>) => ({
		...namespaceEnvironment(),
		FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
		FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
		FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
		FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
		FABRIKA_IAM_RPC_URL: 'http://iam:3000',
		FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
		FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		ENVIRONMENT: 'stage',
		...overrides,
	})

	test('refuses to start without the digest, or with one that names neither console table', () => {
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: undefined }))).toThrow(ControlTableError)
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: `sha256:${'0'.repeat(64)}` }))).toThrow(ControlTableError)
	})

	test('a published table with the oauth row serves MCP, and refuses to start without the origin its resource needs', async () => {
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: true }) }))).toThrow('FABRIKA_CONTROL_DOMAIN')
		const on = createRuntime(
			process({ FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: true }), FABRIKA_CONTROL_DOMAIN: 'console.example.com' }),
		)
		expect(on.mcp).not.toBeNull()
		// The workspace refuses the files the composed provider names, so Zerops' deploy files are never editable.
		expect(on.provider.authoring?.protectedFiles).toEqual(['zerops.yaml', 'zerops.yml'])
		await on.shutdown()
		const off = createRuntime(process({ FABRIKA_CONTROL_DOMAIN: 'console.example.com' }))
		expect(off.mcp).toBeNull()
		await off.shutdown()
	})

	test('the two tables have two digests', () => {
		expect(controlMcpSwitch(controlServiceDigest({ mcp: true }))).toBe(true)
		expect(controlMcpSwitch(controlServiceDigest({ mcp: false }))).toBe(false)
	})
})

describe('the dev sandbox file endpoint a bearer upload may name', () => {
	const host = 'zbox-2ec8-8080.prg1.zerops.app'
	const endpoint = `https://${host}/api/rest/sandbox/abc123/file?path=`
	const cases = [
		{ name: 'encoded absolute path', url: `${endpoint}%2Fsource%2Fapp.tar.gz`, accepted: true },
		{ name: 'literal absolute path', url: `${endpoint}/source/app.tar.gz`, accepted: true },
		{ name: 'single-label subdomain', url: endpoint.replace(host, 'zbox.zerops.app') + '/x', accepted: true },
		{ name: 'relative path', url: `${endpoint}source/app.tar.gz`, accepted: false },
		{ name: 'empty path', url: endpoint, accepted: false },
		{ name: 'no query', url: endpoint.slice(0, -6), accepted: false },
		{ name: 'second query parameter', url: `${endpoint}/x&mode=0600`, accepted: false },
		{ name: 'other query parameter first', url: endpoint.replace('?path=', '?mode=0600&path=') + '/x', accepted: false },
		{ name: 'trailing ampersand', url: `${endpoint}/x&`, accepted: false },
		{ name: 'fragment', url: `${endpoint}/x#fragment`, accepted: false },
		{ name: 'empty fragment', url: `${endpoint}/x#`, accepted: false },
		{ name: 'HTTP', url: endpoint.replace('https:', 'http:') + '/x', accepted: false },
		{ name: 'uppercase protocol', url: endpoint.replace('https:', 'HTTPS:') + '/x', accepted: false },
		{ name: 'uppercase host', url: endpoint.replace(host, host.toUpperCase()) + '/x', accepted: false },
		{ name: 'explicit HTTPS port', url: endpoint.replace('.app/', '.app:443/') + '/x', accepted: false },
		{ name: 'nondefault port', url: endpoint.replace('.app/', '.app:8080/') + '/x', accepted: false },
		{ name: 'userinfo', url: endpoint.replace('https://', 'https://user:secret@') + '/x', accepted: false },
		{ name: 'empty userinfo', url: endpoint.replace('https://', 'https://@') + '/x', accepted: false },
		{ name: 'bare zerops.app', url: endpoint.replace(host, 'zerops.app') + '/x', accepted: false },
		{ name: 'host suffix', url: endpoint.replace('.app/', '.app.attacker.test/') + '/x', accepted: false },
		{ name: 'lookalike host', url: endpoint.replace(host, 'zbox.attackerzerops.app') + '/x', accepted: false },
		{ name: 'object storage host', url: endpoint.replace(host, 'proxy.app-prg1.zerops.io') + '/x', accepted: false },
		{ name: 'uppercase sandbox id', url: endpoint.replace('abc123', 'ABC123') + '/x', accepted: false },
		{ name: 'empty sandbox id', url: endpoint.replace('abc123', '') + '/x', accepted: false },
		{ name: 'overlong sandbox id', url: endpoint.replace('abc123', 'a'.repeat(33)) + '/x', accepted: false },
		{ name: 'other sandbox operation', url: endpoint.replace('/file?', '/exec?') + '/x', accepted: false },
		{ name: 'trailing slash', url: endpoint.replace('/file?', '/file/?') + '/x', accepted: false },
		{ name: 'encoded path segment', url: endpoint.replace('/file?', '/%66ile?') + '/x', accepted: false },
		{ name: 'dot segment', url: endpoint.replace('/sandbox/', '/sandbox/../sandbox/') + '/x', accepted: false },
		{ name: 'space in path', url: `${endpoint}/source app`, accepted: false },
		{ name: 'leading whitespace', url: ` ${endpoint}/x`, accepted: false },
		{ name: 'malformed URL', url: 'https://[invalid?secret', accepted: false },
		{ name: 'empty value', url: '', accepted: false },
	]

	test.each(cases)('$name is accepted only when it is a sandbox file endpoint', ({ url, accepted }) => {
		expect(isZeropsSandboxFileDestination(url)).toBe(accepted)
	})

	test('the composed source port refuses a bearer anywhere else, and a sandbox endpoint without one', async () => {
		let uploads = 0
		const harness = createHarness()
		const env: Env = {
			DB: harness.d1,
			REPOSITORIES: harness.repositories,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: {
				put: () => Promise.resolve(),
				get: () => Promise.resolve(null),
				delete: () => Promise.resolve(),
			},
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'prod',
		}
		const { port } = zeropsGitHubSources(env, {
			uploadFetch: async () => {
				uploads++
				return new Response(null, { status: 200 })
			},
		})
		const base: Omit<ZeropsSourceUploadInput, 'uploadUrl'> = {
			repository: { owner: 'example', name: 'app' },
			commitSha: 'a'.repeat(40),
			descriptorSha256: 'b'.repeat(64),
			archive: { kind: 'application' },
			signal: new AbortController().signal,
		}
		const objectStorage = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private'
		for (const input of [{ uploadUrl: objectStorage, uploadBearer: 'bearer-private' }, { uploadUrl: `${endpoint}/private` }]) {
			const raised = await port.upload({ ...base, ...input }).then(() => undefined, (error: unknown) => error)
			expect(raised).toMatchObject({ code: 'upload_rejected', stage: 'upload' })
			expect(`${String(raised)} ${JSON.stringify(raised)}`).not.toContain('private')
		}
		expect(uploads).toBe(0)
	})
})
