import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ZeropsService } from '../api'
import { withoutSensitiveContent } from '../api/service-env-response'
import { renderYaml } from '../compile'
import { fabrikaZeropsYaml } from '../installation/topology/setups'
import { createZeropsArtifactSourceDescriptor } from '../manifest'
import { namespaceResourceClaims } from '../namespace/claims'
import { envelope, zeropsNamespaceTargetCodec } from '../namespace/codec'
import { ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE } from '../namespace/constants'
import {
	asNamespaceError,
	ZEROPS_PROXY_SANDBOXES_UNSUPPORTED,
	ZEROPS_SANDBOX_HOST_API_OPEN,
	ZEROPS_SANDBOX_HOST_DOMAIN_FORM,
	ZEROPS_SANDBOX_HOST_KEY_REFUSED,
	ZEROPS_SANDBOX_HOST_UNSUPPORTED,
} from '../namespace/errors'
import { assertNamespaceProxyAcceptsSandboxes } from '../namespace/proxy-reads'
import { ensureSandboxHost, type ZeropsSandboxHostApi } from '../namespace/sandbox-host'
import type { NormalizedZeropsNamespaceTarget, ZeropsNamespaceProxySource } from '../namespace/types'
import { FABRIKA_PROXY_MANIFEST_SANDBOXES, zeropsProxyAcceptsSandboxes } from '../proxy-manifest-carrier'
import { SANDBOX_HOST_DOMAIN, SANDBOX_HOST_KEY_VARIABLE } from '../sandbox-host'
import { ZboxApiError, type ZboxDomain, type ZboxFetch } from '../zbox'

const projectId = 'project-1'
const zboxId = 'zbox-service'
const KEY = 'box-key-that-must-never-leave-the-call'
const API_HOST = 'zbox-1a2b-8080.prg1.zerops.app'

const PIN: ZeropsNamespaceProxySource = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}

interface Stored {
	content: string
	sensitive: boolean
}

interface FakeState {
	calls: string[]
	importedYaml: string[]
	services: ZeropsService[]
	env: Map<string, Stored>
	/** The key Box read from its environment at its last start. */
	liveKey: string | undefined
	/** Box ignores its environment and never accepts a key. */
	refusesEveryKey: boolean
	/** Box answers a request without a key: until its next start, or always. */
	openWithoutKey: 'never' | 'untilRestart' | 'always'
	/** The subdomain lines the platform writes once the service is published. */
	subdomainLines: string[]
	domains: ZboxDomain[]
	domainPuts: ZboxDomain[][]
}

const freshState = (): FakeState => ({
	calls: [],
	importedYaml: [],
	services: [],
	env: new Map(),
	liveKey: undefined,
	refusesEveryKey: false,
	openWithoutKey: 'never',
	subdomainLines: [`https://zbox-1a2b-8081.prg1.zerops.app`, `https://${API_HOST}`],
	domains: [{ domain: 'other.example.test', form: 'DASH' }],
	domainPuts: [],
})

const service = (state: FakeState, serviceId: string): ZeropsService => {
	const found = state.services.find((candidate) => candidate.id === serviceId)
	if (found === undefined) throw new Error(`missing service ${serviceId}`)
	return found
}

const makeApi = (state: FakeState): ZeropsSandboxHostApi => ({
	listProjectServices: async () => state.services.map((entry) => ({ ...entry })),
	importServices: async ({ yaml }) => {
		state.calls.push('import')
		state.importedYaml.push(yaml)
		// Measured live: the host is ACTIVE at once, with a key the platform generated itself.
		state.services.push({ id: zboxId, name: 'zbox', projectId, base: 'ubuntu/zbox@1', status: 'ACTIVE', subdomainAccess: false })
		state.env.set(SANDBOX_HOST_KEY_VARIABLE, { content: 'platform-generated-key', sensitive: true })
		state.liveKey = 'platform-generated-key'
		return { projectId, services: [{ id: zboxId, name: 'zbox', processes: [{ id: 'import-zbox' }] }] }
	},
	getProcess: async ({ processId }) => {
		state.calls.push(`wait:${processId}`)
		return { id: processId, status: 'FINISHED' }
	},
	getService: async ({ serviceId }) => ({ ...service(state, serviceId) }),
	putServiceEnv: async ({ serviceId, key, value, sensitive }) => {
		state.calls.push(`put:${serviceId}:${key}:${sensitive ? 'sensitive' : 'readable'}`)
		state.env.set(key, { content: value, sensitive })
	},
	startService: async ({ serviceId }) => {
		state.calls.push(`start:${serviceId}`)
		service(state, serviceId).status = 'ACTIVE'
		state.liveKey = state.env.get(SANDBOX_HOST_KEY_VARIABLE)?.content
		if (state.openWithoutKey === 'untilRestart') state.openWithoutKey = 'never'
		return { id: `start-${serviceId}` }
	},
	stopService: async ({ serviceId }) => {
		state.calls.push(`stop:${serviceId}`)
		service(state, serviceId).status = 'STOPPED'
		return { id: `stop-${serviceId}` }
	},
	enableSubdomainAccess: async ({ serviceId }) => {
		state.calls.push(`enableSubdomain:${serviceId}`)
		service(state, serviceId).subdomainAccess = true
	},
	listServiceEnv: async ({ serviceId }) => {
		const records = [...state.env].map(([key, record]) =>
			withoutSensitiveContent({ id: `${serviceId}:${key}`, key, content: record.content, sensitive: record.sensitive })
		)
		const published = service(state, serviceId).subdomainAccess === true
		return [
			...records,
			...(published ? [{ id: 'sub', key: ZEROPS_NAMESPACE_SUBDOMAIN_VARIABLE, content: state.subdomainLines.join('\n'), sensitive: false }] : []),
		]
	},
})

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Box: accepts exactly the key it read at its last start, and replaces the domain list whole. */
const makeBox = (state: FakeState): ZboxFetch => async (url, init) => {
	const path = new URL(url).pathname
	state.calls.push(`box:${init.method} ${path}`)
	if (new URL(url).host !== API_HOST) throw new Error(`unexpected Box origin ${url}`)
	const live = state.liveKey
	if (init.headers['authorization'] === undefined && state.openWithoutKey !== 'never' && init.method === 'GET' && path === '/api/rest/workspace') {
		return json(200, { version: '1', domains: state.domains })
	}
	if (state.refusesEveryKey || live === undefined || init.headers['authorization'] !== `Bearer ${live}`) {
		return json(401, { error: { code: 'unauthorized', message: 'no' } })
	}
	if (init.method === 'GET' && path === '/api/rest/workspace') return json(200, { version: '1', domains: state.domains })
	if (init.method === 'PUT' && path === '/api/rest/workspace/domains' && typeof init.body === 'string') {
		const body: unknown = JSON.parse(init.body)
		const domains = typeof body === 'object' && body !== null && 'domains' in body && Array.isArray(body.domains) ? body.domains : []
		state.domains = domains
		state.domainPuts.push(domains)
		return json(200, { version: '2', domains })
	}
	return json(404, { error: { code: 'notFound' } })
}

const target = (overrides: Partial<NormalizedZeropsNamespaceTarget> = {}): NormalizedZeropsNamespaceTarget => ({
	proxySource: PIN,
	projectName: 'apps-dev',
	corePackage: 'LIGHT',
	publicAccess: 'custom-domain',
	managed: true,
	ready: true,
	projectId,
	proxyServiceId: 'proxy-service',
	...overrides,
})

const ensure = (state: FakeState, value = target()) =>
	ensureSandboxHost({
		namespaceId: 'apps-dev',
		target: value,
		sandboxKey: KEY,
		api: makeApi(state),
		zboxFetch: makeBox(state),
		sleep: async () => {},
		signal: new AbortController().signal,
	})

const failure = async (promise: Promise<unknown>): Promise<ProviderNamespaceError> => {
	const error = await promise.then(() => null, (cause: unknown) => cause)
	if (!(error instanceof ProviderNamespaceError)) throw new Error(`expected a ProviderNamespaceError, got ${String(error)}`)
	return error
}

describe('the namespace sandbox host', () => {
	const put = `put:${zboxId}:${SANDBOX_HOST_KEY_VARIABLE}:sensitive`

	test('creates the zbox service alone, then keys it by a rekey: the platform started it with its own key', async () => {
		const state = freshState()

		const host = await ensure(state)

		expect(host).toEqual({ serviceId: zboxId, apiOrigin: `https://${API_HOST}` })
		expect(state.importedYaml).toHaveLength(1)
		const yaml = state.importedYaml[0] ?? ''
		expect(yaml).toContain('hostname: zbox')
		expect(yaml).toContain('type: zbox@1')
		expect(yaml).toContain('envIsolation: service')
		expect(yaml).not.toContain('startWithoutCode')
		expect(yaml).not.toContain('hostname: proxy')
		expect(state.env.get(SANDBOX_HOST_KEY_VARIABLE)).toEqual({ content: KEY, sensitive: true })
		expect(state.calls.filter((call) => call === put)).toHaveLength(1)
		expect(state.calls.indexOf(put)).toBeLessThan(state.calls.indexOf(`stop:${zboxId}`))
		expect(state.calls.indexOf(`stop:${zboxId}`)).toBeLessThan(state.calls.indexOf(`start:${zboxId}`))
		expect(state.calls).toContain(`enableSubdomain:${zboxId}`)
		// Every domain already there is kept; the DOT domain is added.
		expect(state.domainPuts).toEqual([[{ domain: 'other.example.test', form: 'DASH' }, { domain: SANDBOX_HOST_DOMAIN, form: 'DOT' }]])
	})

	test('a complete sandbox host is only read on a reconcile', async () => {
		const state = freshState()
		const host = await ensure(state)
		state.calls.length = 0
		state.domainPuts.length = 0

		expect(await ensure(state, target({ sandboxHost: host }))).toEqual(host)

		expect(state.calls.filter((call) => !call.startsWith('box:GET'))).toEqual([])
		expect(state.domainPuts).toEqual([])
	})

	test('a stopped host is started before Box is reached', async () => {
		const state = freshState()
		const host = await ensure(state)
		service(state, zboxId).status = 'STOPPED'
		state.liveKey = undefined
		state.calls.length = 0

		await ensure(state, target({ sandboxHost: host }))

		expect(state.calls).toContain(`start:${zboxId}`)
		expect(state.calls).not.toContain(`stop:${zboxId}`)
	})

	test('a key Box still refuses after the restart fails the namespace, naming no key', async () => {
		const state = freshState()
		state.refusesEveryKey = true

		const error = await failure(ensure(state))

		expect(error.code).toBe(ZEROPS_SANDBOX_HOST_KEY_REFUSED)
		expect(error.retryable).toBe(false)
		expect(`${error.message} ${error.detail ?? ''}`).not.toContain(KEY)
	})

	test('a keyed host whose API answers without a key is rekeyed once, and recorded once it refuses', async () => {
		const state = freshState()
		const host = await ensure(state)
		state.openWithoutKey = 'untilRestart'
		state.calls.length = 0

		expect(await ensure(state, target({ sandboxHost: host }))).toEqual(host)

		expect(state.calls.filter((call) => call === `stop:${zboxId}`)).toHaveLength(1)
		expect(state.calls).toContain(put)
	})

	test('a host whose API still answers without a key after the rekey is never recorded', async () => {
		const state = freshState()
		state.openWithoutKey = 'always'

		const error = await failure(ensure(state))

		expect(error.code).toBe(ZEROPS_SANDBOX_HOST_API_OPEN)
		// The fresh host's own rekey counts: no second restart.
		expect(state.calls.filter((call) => call === `stop:${zboxId}`)).toHaveLength(1)
		expect(state.domainPuts).toEqual([])
	})

	test('refuses a sandbox domain the host routes in DASH form rather than adding a duplicate', async () => {
		const state = freshState()
		state.domains = [{ domain: SANDBOX_HOST_DOMAIN, form: 'DASH' }]

		const error = await failure(ensure(state))

		expect(error.code).toBe(ZEROPS_SANDBOX_HOST_DOMAIN_FORM)
		expect(state.domainPuts).toEqual([])
	})

	test('refuses a zerops-subdomain namespace before any platform call', async () => {
		const state = freshState()

		const error = await failure(ensure(state, target({ publicAccess: 'zerops-subdomain' })))

		expect(error.code).toBe(ZEROPS_SANDBOX_HOST_UNSUPPORTED)
		expect(error.message).toContain('custom-domain namespace')
		expect(state.calls).toEqual([])
	})

	test('refuses when the recorded sandbox host is gone, and creates nothing in its place', async () => {
		const state = freshState()

		await expect(ensure(state, target({ sandboxHost: { serviceId: zboxId, apiOrigin: `https://${API_HOST}` } }))).rejects.toThrow(
			'sandbox host service identity changed',
		)
		expect(state.calls).not.toContain('import')
	})

	test('a host that publishes no API subdomain yet is a retryable failure', async () => {
		const state = freshState()
		state.subdomainLines = ['https://zbox-1a2b-8081.prg1.zerops.app']

		const error = await failure(ensure(state))

		expect(error.code).toBe('sandboxHostNotPublished')
		expect(error.retryable).toBe(true)
	})
})

describe('Box failures as namespace errors', () => {
	test('an unreachable, overloaded or failing Box is retryable; a refusal is not; only the code is named', () => {
		const cases: ReadonlyArray<readonly [number, string, boolean]> = [
			[0, 'unreachable', true],
			[503, 'http_503', true],
			[429, 'rateLimited', true],
			[400, 'invalidUserInput', false],
		]
		for (const [status, code, retryable] of cases) {
			const error = asNamespaceError(new ZboxApiError('get workspace', status, code), 'reconcile')
			expect(error.code).toBe(code)
			expect(error.retryable).toBe(retryable)
			expect(error.message).toBe(`zbox: get workspace failed (${status === 0 ? code : `${status} ${code}`})`)
		}
	})
})

describe('the proxy sandboxes marker', () => {
	test('the generated proxy setup declares it, and a pin without it does not accept sandbox entries', async () => {
		expect(zeropsProxyAcceptsSandboxes(renderYaml(fabrikaZeropsYaml))).toBe(true)
		expect(zeropsProxyAcceptsSandboxes(PIN.descriptor.contents)).toBe(false)
		expect(
			zeropsProxyAcceptsSandboxes(`zerops:\n  - setup: proxy\n    build:\n      envVariables:\n        ${FABRIKA_PROXY_MANIFEST_SANDBOXES}: "1"\n`),
		)
			.toBe(true)
	})

	test('a namespace pinned without it is refused with the re-pin command', () => {
		let caught: unknown
		try {
			assertNamespaceProxyAcceptsSandboxes('apps-dev', PIN)
		} catch (error) {
			caught = error
		}
		if (!(caught instanceof ProviderNamespaceError)) throw new Error('expected a ProviderNamespaceError')
		expect(caught.code).toBe(ZEROPS_PROXY_SANDBOXES_UNSUPPORTED)
		expect(caught.message).toContain('fabrika control namespaces update --namespace=apps-dev --proxy-source=current')
	})
})

describe('the recorded sandbox host', () => {
	const recorded = { serviceId: zboxId, apiOrigin: `https://${API_HOST}` }
	const pinned = { proxySource: { repository: { ...PIN.repository }, commitSha: PIN.commitSha, descriptor: { ...PIN.descriptor } } }

	test('round-trips through the target codec, which refuses any other shape', () => {
		expect(zeropsNamespaceTargetCodec.decode({ ...pinned, sandboxHost: recorded }).sandboxHost).toEqual(recorded)
		for (
			const invalid of [
				{ ...recorded, extra: true },
				{ serviceId: zboxId },
				{ ...recorded, apiOrigin: `http://${API_HOST}` },
				{ ...recorded, apiOrigin: `https://${API_HOST}/api` },
				{ ...recorded, serviceId: '' },
			]
		) expect(() => zeropsNamespaceTargetCodec.decode({ ...pinned, sandboxHost: invalid })).toThrow('sandboxHost')
	})

	test('claims the zbox service for the namespace once it is recorded', () => {
		const namespace = (sandboxHost?: typeof recorded) => ({
			id: 'apps-dev',
			env: 'dev',
			target: envelope({ proxySource: PIN, ...(sandboxHost === undefined ? {} : { sandboxHost }) }),
		})
		expect(namespaceResourceClaims(namespace())).not.toContain('service:zbox')
		expect(namespaceResourceClaims(namespace(recorded))).toContain('service:zbox')
	})
})
