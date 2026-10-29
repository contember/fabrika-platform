// The per-workspace dev sandboxes on Zerops (ADR-0049 rule 10): registration imports no service, the lifecycle finds a
// workspace's sandbox again by name, and a deploy builds and starts the launcher inside the sandbox. Every Box call goes
// through a recording fake; no credential may reach an exec or process argument.

import { parseManagedEnvironment } from '@fabrika/auth-core'
import {
	type JsonValue,
	PROVIDER_DEV_CAPACITY,
	PROVIDER_DEV_HOST_PENDING,
	type ProviderDeployInput,
	type ProviderDeploymentNamespace,
	type ProviderEnvironment,
	ProviderNamespaceError,
	ProviderSecretError,
} from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { createZeropsApi } from '../api'
import { createZeropsControlProvider, zeropsStoredTargetCodec } from '../control'
import type { ZeropsRuntimePackage } from '../execution'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, zeropsArtifactCodec } from '../manifest'
import { zeropsNamespaceTargetCodec } from '../namespace'
import { readSandboxBaseContext, sandboxBaseName } from '../sandbox/base-image'
import { SessionOutputRelay } from '../sandbox/deploy'
import { assertSandboxArtifact } from '../sandbox/dev-artifact'
import { sandboxIdempotencyKey, sandboxName } from '../sandbox/lifecycle'
import { readSandboxScripts, SANDBOX_SCRIPT_FILES } from '../sandbox/scripts'
import type { ZeropsSourcePort, ZeropsSourceUploadInput } from '../source/port'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'
import { approvedContract } from './fixtures/access'
import { FakeBox } from './sandbox-fake-box'

const WORKSPACE = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const SANDBOX_KEY = 'box-api-key-do-not-leak'
const PROXY_SECRET = 'private-proxy-secret-value'
const APP_SECRET = 'app-secret-value-do-not-leak'
const API_ORIGIN = 'https://zbox-8080.prg1.zerops.app'
const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const PROXY_SOURCE = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: COMMIT_SHA,
	descriptor: await createZeropsArtifactSourceDescriptor(
		'zerops:\n  - setup: proxy\n    build:\n      envVariables:\n        FABRIKA_PROXY_MANIFEST_SANDBOXES: "1"\n',
	),
}
/** A pin of a release before dev sandboxes: its proxy cannot parse a sandbox entry. */
const UNMARKED_PROXY_SOURCE = { ...PROXY_SOURCE, descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n') }
const DESCRIPTOR = await createZeropsArtifactSourceDescriptor(
	'zerops:\n  - setup: notesapi\n    build:\n      buildCommands: ["bun run build:web"]\n',
)

const MANAGED: Readonly<Record<string, string | null>> = {
	FABRIKA_RELEASE: 'r1',
	FABRIKA_OPERATIONS_DSN: null,
	FABRIKA_IAM_ISSUER: null,
	FABRIKA_IAM_APP_ID: null,
	FABRIKA_APP_ID: null,
	FABRIKA_ENVIRONMENT: null,
	FABRIKA_SERVICE_KEY: null,
	FABRIKA_PROXY_SECRET: PROXY_SECRET,
	FABRIKA_IAM_RPC_URL: null,
	FABRIKA_IAM_RPC_KEY: null,
	FABRIKA_APP_ORIGIN: `https://${WORKSPACE}.dev.example.test`,
	FABRIKA_TOKEN_KEYS: null,
}

const devConfig = (extra: ZeropsServiceSpec[] = [], runtimePackages: ZeropsRuntimePackage[] = []): ZeropsAppConfig => ({
	id: 'notes',
	pipeline: { vars: ['GREETING'] },
	target: {
		platform: 'zerops',
		deployService: 'notesapi',
		contract: notesArtifact,
		proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) },
		...(runtimePackages.length === 0 ? {} : { runtimePackages }),
		services: () => [
			{ hostname: 'notesapi', type: 'alpine/bun@1.3' },
			{ hostname: 'notesdb', type: 'postgresql:single@18' },
			...extra,
		],
	},
})

const namespace = (
	options: { sandboxHost?: boolean; publicAccess?: 'custom-domain' | 'zerops-subdomain'; proxySource?: typeof PROXY_SOURCE } = {},
): ProviderDeploymentNamespace => ({
	id: 'apps-dev',
	env: 'dev',
	target: {
		provider: 'zerops',
		version: zeropsNamespaceTargetCodec.version,
		payload: zeropsNamespaceTargetCodec.encode({
			proxySource: options.proxySource ?? PROXY_SOURCE,
			projectId: 'project-1',
			proxyServiceId: 'proxy-1',
			ready: true,
			...(options.publicAccess === undefined ? {} : { publicAccess: options.publicAccess }),
			...(options.sandboxHost === false ? {} : { sandboxHost: { serviceId: 'zbox-1', apiOrigin: API_ORIGIN } }),
		}),
	},
})

const devEnvironment = (overrides: Partial<ProviderEnvironment> = {}, config = devConfig()): ProviderEnvironment => ({
	appId: 'notes',
	env: 'dev',
	kind: 'dev',
	domain: 'dev.example.test',
	namespace: namespace(),
	target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ kind: 'devSandboxes' }) },
	artifact: {
		provider: 'zerops',
		version: zeropsArtifactCodec.version,
		payload: zeropsArtifactCodec.encode(compileFabrikaManifest(config, 'dev', DESCRIPTOR)),
	},
	access: approvedContract(),
	...overrides,
})

/** Every Zerops API call is recorded and refused: a dev environment's sandbox never touches a Zerops service. */
const zeropsCalls: string[] = []
const noZerops = createZeropsApi({
	token: 'zt-secret',
	fetchImpl: async (input) => {
		zeropsCalls.push(String(input))
		throw new Error('unexpected Zerops call')
	},
})

const providerLog: string[] = []

/** A dev environment an older release registered with its own Zerops service. */
const pinnedServiceTarget: ProviderEnvironment['target'] = {
	provider: 'zerops',
	version: zeropsStoredTargetCodec.version,
	payload: zeropsStoredTargetCodec.encode({ serviceId: 'service-1' }),
}
const REREGISTER = 'zerops: dev environment `notes/dev` was registered with its own Zerops service, which this release no longer runs; '
	+ 'delete the environment and register it again with --kind=dev and a wildcard domain'

interface Harness {
	box: FakeBox
	uploads: ZeropsSourceUploadInput[]
	control: ReturnType<typeof createZeropsControlProvider>
}

const harness = (box = new FakeBox()): Harness => {
	const uploads: ZeropsSourceUploadInput[] = []
	const source: ZeropsSourcePort = {
		resolve: () => Promise.reject(new Error('unexpected resolve')),
		upload: async (input) => {
			uploads.push(input)
			return { commitSha: input.commitSha, descriptorSha256: input.descriptorSha256, entryCount: 42, expandedBytes: 1000 }
		},
	}
	const control = createZeropsControlProvider({
		log: (line) => {
			providerLog.push(line)
		},
		accessToken: 'zt-secret',
		api: noZerops,
		source,
		zboxFetch: box.fetch,
		// A sleep advances the clock, so a deadline passes without waiting for it.
		sleep: async (ms) => {
			setSystemTime(new Date(Date.now() + ms))
		},
		namespaces: {
			clientId: 'client-1',
			proxySource: PROXY_SOURCE,
			iamUrl: 'https://iam.example.test',
			iamKey: 'proxy-key',
			olderProxies: [{ row: () => true, csp: () => true, signsOut: false }],
		},
	})
	return { box, uploads, control }
}

afterEach(() => {
	providerLog.length = 0
	setSystemTime()
	expect(zeropsCalls).toEqual([])
})

const signal = (): AbortSignal => new AbortController().signal

const sandboxes = (control: Harness['control']) => {
	const lifecycle = control.devSandboxes
	if (lifecycle === undefined) throw new Error('the Zerops provider gives a dev environment workspace sandboxes')
	return lifecycle
}

describe('dev sandbox lifecycle', () => {
	test('ensure builds the base once, creates the workspace sandbox, and finds it again by name', async () => {
		const { box, control } = harness()
		const first = await sandboxes(control).ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
		expect(first).toEqual({ sandboxId: 'sb1', baseDigest: 'sha256:built-base', upstreamHost: '3000-sb1.sandbox.fabrika.internal' })

		const context = await readSandboxBaseContext()
		expect(context.name).toMatch(/^fabrika-dev-[0-9a-f]{12}$/)
		expect(sandboxBaseName(context.files)).toBe(context.name)
		const build = box.requests.find((request) => request.path === '/base-build')
		expect(build?.query.get('name')).toBe(context.name)
		const tar = build?.bytes ?? new Uint8Array()
		expect(new TextDecoder().decode(tar.subarray(257, 262))).toBe('ustar')
		const archived = await new Bun.Archive(tar).files()
		expect([...archived.keys()].sort()).toEqual(['Dockerfile', 'init.sh'])

		const create = box.requests.find((request) => request.method === 'POST' && request.path === '/sandbox')
		expect(create?.json).toEqual({
			name: `fabrika-${WORKSPACE}`,
			baseDigest: 'sha256:built-base',
			cpus: 2,
			memoryBytes: 2 * 1024 * 1024 * 1024,
			networkMode: 'INTERNET',
			integrations: [],
			launch: { entrypoint: ['/bin/sh'], cmd: ['/usr/local/lib/fabrika/init.sh'] },
			policy: { ingress: { ports: [{ port: 3000, access: 'PROJECT', protocol: 'HTTP', wakeOnRequest: true }] }, secrets: { mode: 'NONE' } },
			waitSeconds: 30,
		})
		expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(create?.headers['authorization']).toBe(`Bearer ${SANDBOX_KEY}`)

		const before = box.requests.length
		const again = await sandboxes(control).ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
		expect(again).toEqual(first)
		const second = box.requests.slice(before).map((request) => `${request.method} ${request.path}`)
		expect(second).not.toContain('POST /sandbox')
		expect(second).not.toContain('POST /base-build')
	})

	test('ensure keeps a sandbox on an older base and wakes a parked one', async () => {
		const box = new FakeBox()
		box.addSandbox({ id: 'sb9', name: `fabrika-${WORKSPACE}`, status: 'PARKED', baseDigest: 'sha256:old-base' })
		const { control } = harness(box)
		const ensured = await sandboxes(control).ensure({
			environment: devEnvironment(),
			workspaceId: WORKSPACE,
			sandboxKey: SANDBOX_KEY,
			signal: signal(),
		})
		expect(ensured).toEqual({ sandboxId: 'sb9', baseDigest: 'sha256:old-base', upstreamHost: '3000-sb9.sandbox.fabrika.internal' })
		expect(box.requests.map((request) => `${request.method} ${request.path}`)).toContain('POST /sandbox/sb9/wake')
		expect(box.requests.some((request) => request.path === '/base-build' || request.path === '/sandbox')).toBe(false)
	})

	test('ensure removes a FAILED sandbox and creates a new one', async () => {
		const box = new FakeBox()
		box.addSandbox({ id: 'sb7', name: `fabrika-${WORKSPACE}`, status: 'FAILED' })
		const { control } = harness(box)
		const ensured = await sandboxes(control).ensure({
			environment: devEnvironment(),
			workspaceId: WORKSPACE,
			sandboxKey: SANDBOX_KEY,
			signal: signal(),
		})
		expect(ensured.sandboxId).toBe('sb1')
		const deleted = box.requests.find((request) => request.method === 'DELETE')
		expect(deleted?.path).toBe('/sandbox/sb7')
		expect(deleted?.headers['idempotency-key']).toBe(sandboxIdempotencyKey('delete', 'sb7'))
		expect(providerLog).toEqual([`zerops: workspace ${WORKSPACE}'s sandbox sb7 had ended; it is replaced by sandbox sb1, with an empty database`])
	})

	test('a full sandbox host is the contract capacity error, on create and on wake', async () => {
		const { control } = harness(new FakeBox({ full: true }))
		const ensure = sandboxes(control).ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
		await expect(ensure).rejects.toBeInstanceOf(ProviderNamespaceError)
		await expect(ensure).rejects.toMatchObject({ code: PROVIDER_DEV_CAPACITY, retryable: true })

		const parked = new FakeBox({ full: true })
		parked.addSandbox({ id: 'sb3', status: 'PARKED' })
		const wake = sandboxes(harness(parked).control).wake({
			environment: devEnvironment(),
			sandbox: { sandboxId: 'sb3' },
			sandboxKey: SANDBOX_KEY,
			signal: signal(),
		})
		await expect(wake).rejects.toMatchObject({ code: PROVIDER_DEV_CAPACITY })
	})

	test('refuses a base that failed to build, and a base the host lists as FAILED', async () => {
		const failing = harness(new FakeBox({ baseBuildStatus: 'FAILED' }))
		await expect(
			sandboxes(failing.control).ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() }),
		)
			.rejects.toThrow(/dev sandbox base `fabrika-dev-[0-9a-f]{12}` failed to build/)

		const listed = new FakeBox()
		listed.bases.push({ digest: 'sha256:x', name: (await readSandboxBaseContext()).name, status: 'FAILED' })
		const refused = harness(listed)
		await expect(
			sandboxes(refused.control).ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() }),
		)
			.rejects.toThrow(/failed to build on the sandbox host/)
		expect(listed.requests.some((request) => request.path === '/base-build' || request.path === '/sandbox')).toBe(false)
	})

	test('park, wake and remove converge, and remove treats a sandbox already gone as removed', async () => {
		const box = new FakeBox()
		box.addSandbox({ id: 'sb5' })
		const lifecycle = sandboxes(harness(box).control)
		const input = { environment: devEnvironment(), sandbox: { sandboxId: 'sb5' }, sandboxKey: SANDBOX_KEY, signal: signal() }
		await lifecycle.park(input)
		await lifecycle.park(input)
		expect(box.requests.filter((request) => request.path === '/sandbox/sb5/park').map((request) => request.json)).toEqual([{ memory: true }])
		await lifecycle.wake(input)
		await lifecycle.wake(input)
		expect(box.requests.filter((request) => request.path === '/sandbox/sb5/wake')).toHaveLength(1)
		await lifecycle.remove({ ...input, workspaceId: WORKSPACE })
		await lifecycle.remove({ ...input, workspaceId: WORKSPACE })
		expect(box.sandboxes.has('sb5')).toBe(false)
	})

	test('a sandbox created again after a removal is created under another key, so Box replays no answer naming the removed one', async () => {
		const box = new FakeBox()
		const lifecycle = sandboxes(harness(box).control)
		const ensure = () => lifecycle.ensure({ environment: devEnvironment(), workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
		const first = await ensure()
		await lifecycle.remove({
			environment: devEnvironment(),
			workspaceId: WORKSPACE,
			sandbox: { sandboxId: first.sandboxId },
			sandboxKey: SANDBOX_KEY,
			signal: signal(),
		})
		const second = await ensure()
		expect(second.sandboxId).not.toBe(first.sandboxId)
		const keys = box.requests.filter((request) => request.method === 'POST' && request.path === '/sandbox').map((request) =>
			request.headers['idempotency-key']
		)
		expect(keys).toHaveLength(2)
		expect(new Set(keys).size).toBe(2)
	})

	test('a namespace pinned to a proxy that cannot serve sandboxes is refused by admit and by ensure, before any Box call', async () => {
		const { box, control } = harness()
		const environment = devEnvironment({ namespace: namespace({ proxySource: UNMARKED_PROXY_SOURCE }) })
		const refusal = (run: () => unknown) => {
			try {
				run()
				return null
			} catch (cause) {
				return cause instanceof ProviderNamespaceError ? [cause.code, cause.retryable] : cause
			}
		}
		expect(refusal(() => sandboxes(control).admit({ environment }))).toEqual(['proxySandboxesUnsupported', false])
		expect(refusal(() => sandboxes(control).admit({ environment: devEnvironment() }))).toBeNull()
		const ensured = await sandboxes(control).ensure({ environment, workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
			.catch((cause: unknown) => cause)
		expect(ensured instanceof ProviderNamespaceError ? ensured.code : ensured).toBe('proxySandboxesUnsupported')
		expect(box.requests).toEqual([])
	})

	test('remove without a recorded sandbox finds the workspace sandbox by name, and treats none as removed', async () => {
		const box = new FakeBox()
		box.addSandbox({ id: 'sb6', name: sandboxName(WORKSPACE) })
		box.addSandbox({ id: 'sb7', name: sandboxName('01a1a2b3-0000-7000-8000-0000000000ff') })
		const lifecycle = sandboxes(harness(box).control)
		const input = { environment: devEnvironment(), workspaceId: WORKSPACE, sandbox: null, sandboxKey: SANDBOX_KEY, signal: signal() }
		await lifecycle.remove(input)
		await lifecycle.remove(input)
		expect(box.sandboxes.has('sb6')).toBe(false)
		expect(box.sandboxes.has('sb7')).toBe(true)
	})

	test('a namespace without a sandbox host yet: ensure says so by code and remove has nothing to remove', async () => {
		const { box, control } = harness()
		const environment = devEnvironment({ namespace: namespace({ sandboxHost: false }) })
		const pending = await sandboxes(control).ensure({ environment, workspaceId: WORKSPACE, sandboxKey: SANDBOX_KEY, signal: signal() })
			.catch((cause: unknown) => cause)
		expect(pending instanceof ProviderNamespaceError ? [pending.code, pending.retryable] : pending).toEqual([PROVIDER_DEV_HOST_PENDING, true])
		await sandboxes(control).remove({ environment, workspaceId: WORKSPACE, sandbox: null, sandboxKey: SANDBOX_KEY, signal: signal() })
		expect(box.requests).toEqual([])
	})

	test('refuses an environment that is not dev', async () => {
		const { control } = harness()
		await expect(
			sandboxes(control).ensure({
				environment: devEnvironment({ kind: 'standard' }),
				workspaceId: WORKSPACE,
				sandboxKey: SANDBOX_KEY,
				signal: signal(),
			}),
		)
			.rejects.toThrow('only a dev environment')
		await expect(
			sandboxes(control).ensure({
				environment: devEnvironment({ target: pinnedServiceTarget }),
				workspaceId: WORKSPACE,
				sandboxKey: SANDBOX_KEY,
				signal: signal(),
			}),
		).rejects.toThrow(REREGISTER)
		// Before Control records anything, so `bind_dev` answers the author with the remedy.
		expect(() => sandboxes(control).admit({ environment: devEnvironment({ target: pinnedServiceTarget }) })).toThrow(REREGISTER)
	})
})

interface Events {
	logs: string[]
	externalIds: Array<{ id: string; state: JsonValue | undefined }>
	checkpoints: JsonValue[]
}

const deployInput = (events: Events, overrides: Partial<ProviderDeployInput> = {}): ProviderDeployInput => ({
	runId: 'run-1',
	app: { id: 'notes', source: { repoUrl: 'https://github.com/acme/notes', ref: COMMIT_SHA } },
	environment: devEnvironment(),
	secrets: { API_TOKEN: APP_SECRET },
	vars: { GREETING: "it's dev" },
	managedEnvironment: parseManagedEnvironment(MANAGED),
	devSandbox: { workspaceId: WORKSPACE, sandboxId: 'sb1', origin: `https://${WORKSPACE}.dev.example.test`, sandboxKey: SANDBOX_KEY },
	dryRun: false,
	signal: signal(),
	events: {
		log: (line) => {
			events.logs.push(line)
		},
		externalId: async (id, state) => {
			events.externalIds.push({ id, state })
		},
		checkpoint: async (state) => {
			events.checkpoints.push(state)
		},
		boundary: async () => {},
	},
	...overrides,
})

const freshEvents = (): Events => ({ logs: [], externalIds: [], checkpoints: [] })

const deployHarness = (options: ConstructorParameters<typeof FakeBox>[0] = {}) => {
	const box = new FakeBox({ buildOutput: ['fabrika-build: step 1/9\nbuilding', ' the web\nfabrika-build: done\n'], ...options })
	box.addSandbox({ id: 'sb1', status: 'PARKED' })
	return harness(box)
}

const fileOf = (box: FakeBox, path: string) => box.files.get(`sb1:${path}`)

describe('dev sandbox deploy', () => {
	test('runs its steps in order inside the sandbox and relays the build output', async () => {
		const { box, control, uploads } = deployHarness()
		const events = freshEvents()
		const outcome = await control.deploy(deployInput(events))
		expect(outcome).toEqual({ state: 'succeeded' })

		const steps = events.logs.filter((line) => /^[→✓✗] /.test(line)).map((line) => line.replace(/ \(\d+\.\ds\)$/, ''))
		const order = [
			'wake-sandbox',
			'install-scripts',
			'stop-previous',
			'upload-source',
			'build',
			'write-env',
			'write-launcher-config',
			'start-launcher',
			'await-boot',
		]
		expect(steps).toEqual(order.flatMap((id) => [`→ ${id}`, `✓ ${id}`]))
		expect(events.logs).toContain('  │ fabrika-build: step 1/9')
		expect(events.logs).toContain('  │ building the web')
		expect(events.logs).toContain('  │ fabrika-build: done')

		expect(events.externalIds).toEqual([{ id: 'sandbox:sb1:run-1', state: { sandboxId: 'sb1', runId: 'run-1' } }])
		expect(events.checkpoints).toEqual([{ sandboxId: 'sb1', runId: 'run-1', buildSessionId: 'session-build' }])

		const scripts = await readSandboxScripts()
		const bin = `/var/lib/fabrika/bin/${scripts.version}`
		const writes = box.requests.flatMap((request) =>
			request.method === 'PUT'
				? [`PUT ${request.query.get('path')} ${request.query.get('mode')}`]
				: request.method === 'POST'
				? [`POST ${request.path}`]
				: []
		)
		expect(writes).toEqual([
			'POST /sandbox/sb1/wake',
			'POST /sandbox/sb1/exec',
			...SANDBOX_SCRIPT_FILES.map((name) => `PUT ${bin}/${name} 0700`),
			'PUT /var/lib/fabrika/bin/current 0600',
			'POST /sandbox/sb1/exec',
			'POST /sandbox/sb1/exec',
			'PUT /var/lib/fabrika/build.sh 0700',
			'POST /sandbox/sb1/process',
			// The environment exists only once the build that runs the application's code has ended.
			'PUT /var/lib/fabrika/env 0600',
			'PUT /app/fabrika/dev.generated.json null',
			'POST /sandbox/sb1/exec',
		])
		expect(box.commands()).toEqual([
			['/bin/sh', '-c', `set -eu; mkdir -p ${bin}; chmod 700 /var/lib/fabrika/bin ${bin}`],
			['/bin/sh', `${bin}/reset.sh`],
			expect.arrayContaining(['/bin/sh', '-c']),
			['/bin/sh', '/var/lib/fabrika/build.sh'],
			['/bin/sh', `${bin}/start-launcher.sh`],
		])
		expect(box.commands()[2]?.[2]).toContain('tar -xzf /tmp/fabrika-source.tar.gz -C /app.next')
		expect(new TextDecoder().decode(fileOf(box, `${bin}/run-build.sh`)?.bytes)).toBe(new TextDecoder().decode(scripts.files['run-build.sh']))
		expect(new TextDecoder().decode(fileOf(box, '/var/lib/fabrika/bin/current')?.bytes)).toBe(`${scripts.version}\n`)

		expect(uploads).toHaveLength(1)
		const upload = uploads[0]
		if (upload === undefined) throw new Error('expected a source upload')
		expect(upload.uploadUrl).toBe(`${API_ORIGIN}/api/rest/sandbox/sb1/file?path=/tmp/fabrika-source.tar.gz`)
		// Control's destination check compares the URL with its parsed form.
		expect(new URL(upload.uploadUrl).href).toBe(upload.uploadUrl)
		expect(upload.uploadBearer).toBe(SANDBOX_KEY)
		expect(upload.commitSha).toBe(COMMIT_SHA)

		const config = JSON.parse(new TextDecoder().decode(fileOf(box, '/app/fabrika/dev.generated.json')?.bytes))
		expect(config).toMatchObject({ format: 1, appId: 'notes', head: COMMIT_SHA, port: 3000, healthPath: '/healthz', spaBuild: ['bun run build:web'] })
		expect(config.checks.map((check: { name: string }) => check.name)).toEqual(['tests', 'tsc', 'fabrika-check'])
		const script = new TextDecoder().decode(fileOf(box, '/var/lib/fabrika/build.sh')?.bytes)
		expect(fileOf(box, '/var/lib/fabrika/build.sh')?.mode).toBe('0700')
		const digest = new Bun.CryptoHasher('sha256').update('bun run build:web\n').digest('hex')
		expect(script).toStartWith('#!/bin/sh\n# Generated by the dev sandbox deploy.\nset -eu\n')
		expect(script).toContain(
			`cat > /var/lib/fabrika/build/1.sh <<'FABRIKA_BUILD_STEP_EOF'\nbun run build:web\nFABRIKA_BUILD_STEP_EOF\necho '${digest}  /var/lib/fabrika/build/1.sh' | sha256sum -c -s\n`,
		)
		expect(script).toEndWith(`exec /bin/sh ${bin}/run-build.sh 9\n`)
	})

	test('writes the env file 0600 with the secrets, the managed values and the run literals', async () => {
		const { box, control } = deployHarness()
		await control.deploy(deployInput(freshEvents()))
		const file = fileOf(box, '/var/lib/fabrika/env')
		expect(file?.mode).toBe('0600')
		const text = new TextDecoder().decode(file?.bytes)
		// What the base image's launcher script does with it: `set -a; . <file>`.
		const shell = Bun.spawnSync(['sh', '-c', 'set -a; . /dev/stdin; set +a; env'], { stdin: new TextEncoder().encode(text), env: {} })
		const environment = Object.fromEntries(
			shell.stdout.toString().split('\n').filter((line) => line.includes('=')).map((
				line,
			) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
		)
		expect(environment).toMatchObject({
			API_TOKEN: APP_SECRET,
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
			FABRIKA_APP_ORIGIN: `https://${WORKSPACE}.dev.example.test`,
			FABRIKA_RELEASE: 'r1',
			PORT: '3000',
			FABRIKA_CONTRACT_DIGEST: approvedContract().contractDigest,
			FABRIKA_APP_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/postgres',
			FABRIKA_APP_DATABASE_CONNECTIONS: '10',
		})
		expect(environment).not.toHaveProperty('FABRIKA_IAM_RPC_KEY')
		// A declared variable only fills the Zerops import document; a Zerops deploy writes none into the service.
		expect(environment).not.toHaveProperty('GREETING')
	})

	test('no credential reaches an exec or process argument, a launch, or a request other than the upload', async () => {
		const { box, control, uploads } = deployHarness()
		const events = freshEvents()
		await control.deploy(deployInput(events))
		const credentials = [SANDBOX_KEY, PROXY_SECRET, APP_SECRET]
		const envFile = '/var/lib/fabrika/env'
		for (const request of box.requests) {
			const visible = `${request.path}?${request.query.toString()} ${JSON.stringify(request.json)}`
			for (const credential of credentials) expect(visible).not.toContain(credential)
			if (request.query.get('path') !== envFile && request.bytes !== null) {
				for (const credential of credentials) expect(new TextDecoder().decode(request.bytes)).not.toContain(credential)
			}
			expect(Object.keys(request.json ?? {})).not.toContain('env')
		}
		for (const line of events.logs) for (const credential of credentials) expect(line).not.toContain(credential)
		expect(uploads[0]?.uploadUrl).not.toContain(SANDBOX_KEY)
	})

	test('a failed build fails the run and starts no launcher', async () => {
		const { box, control } = deployHarness({ buildExitCode: 2 })
		const events = freshEvents()
		expect(await control.deploy(deployInput(events))).toEqual({ state: 'failed' })
		expect(events.logs).toContain('✗ build: zerops: the build failed with exit code 2')
		expect(box.commands().some((command) => command.join(' ').includes('start-launcher'))).toBe(false)
		expect(fileOf(box, '/app/fabrika/dev.generated.json')).toBeUndefined()
		expect(fileOf(box, '/var/lib/fabrika/env')).toBeUndefined()
	})

	test('a launcher that never reports its boot fails the run after the readiness window, with its log masked', async () => {
		const { box, control } = deployHarness({ bootAfterReads: null })
		const password = 'local-superuser-password-1'
		box.files.set('sb1:/var/lib/fabrika/postgres-password', { bytes: new TextEncoder().encode(`${password}\n`), mode: null })
		box.files.set('sb1:/var/lib/fabrika/launcher.log', {
			bytes: new TextEncoder().encode(
				`booting\nconnecting with ${PROXY_SECRET}\npostgres://postgres:${password}@127.0.0.1:5432/postgres refused\nfabrika dev: the application exited with code 1\n`,
			),
			mode: null,
		})
		const events = freshEvents()
		expect(await control.deploy(deployInput(events))).toEqual({ state: 'failed' })
		expect(events.logs).toContain(
			'✗ await-boot: zerops: the dev launcher did not report its boot within 180 s; its log ends: '
				+ 'booting | connecting with [redacted] | postgres://postgres:[redacted]@127.0.0.1:5432/postgres refused | '
				+ 'fabrika dev: the application exited with code 1',
		)
	})

	test('the relayed build output masks every value of the environment and the sandbox key', async () => {
		const { control } = deployHarness({ buildOutput: [`token ${APP_SECRET}\n`, `key ${SANDBOX_KEY} and ${PROXY_SECRET}\n`] })
		const events = freshEvents()
		await control.deploy(deployInput(events))
		expect(events.logs).toContain('  │ token [redacted]')
		expect(events.logs).toContain('  │ key [redacted] and [redacted]')
	})

	test('refuses what a sandbox cannot give, with one line each, before any Box call', async () => {
		const cases: Array<{ input: (events: Events) => ProviderDeployInput; error: string }> = [
			{
				input: (events) =>
					deployInput(events, { environment: devEnvironment({}, devConfig([{ hostname: 'notesfiles', type: 'object-storage', objectStorageSize: 1 }])) }),
				error:
					"zerops: a dev environment runs in workspace sandboxes, which have no object storage; remove `notesfiles` from the dev environment's config",
			},
			{
				input: (events) => deployInput(events, { vars: { GREETING: '${notesdb_password}' } }),
				error: 'zerops: a dev environment runs in workspace sandboxes, which resolve no `${…}` reference; the variable `GREETING` holds one',
			},
			{
				input: (events) => deployInput(events, { secrets: { API_TOKEN: 'x${notesdb_password}' } }),
				error: 'zerops: a dev environment runs in workspace sandboxes, which resolve no `${…}` reference; the secret `API_TOKEN` holds one',
			},
			{
				input: (events) => {
					const { devSandbox: _devSandbox, ...input } = deployInput(events)
					return input
				},
				error: 'zerops: a dev environment deploys only into a workspace sandbox, through bind_dev',
			},
			{
				input: (events) => deployInput(events, { environment: devEnvironment({ target: pinnedServiceTarget }) }),
				error: REREGISTER,
			},
			{
				input: (events) => deployInput(events, { environment: devEnvironment({}, devConfig([], ['ffmpeg'])) }),
				error:
					"zerops: a dev environment runs in workspace sandboxes, which install no runtime package; remove runtimePackages (ffmpeg) from the dev environment's config",
			},
		]
		for (const { input, error } of cases) {
			const { box, control } = deployHarness()
			await expect(control.deploy(input(freshEvents()))).rejects.toThrow(error)
			expect(box.requests).toEqual([])
		}
	})

	test('the output relay sends only new bytes, and reports a cut buffer once and resumes at its end', () => {
		const lines: string[] = []
		const relay = new SessionOutputRelay((line) => void lines.push(line), [PROXY_SECRET])
		const bytes = (text: string) => new TextEncoder().encode(text)
		relay.accept(bytes('one\ntw'))
		relay.accept(bytes('one\ntwo\nthr'))
		expect(lines).toEqual(['  │ one', '  │ two'])
		// The host dropped the head of its buffer: what was relayed is no longer where it was.
		relay.accept(bytes('xyz\nmore'))
		relay.accept(bytes('xyz\nmore\nlast\n'))
		relay.flush()
		expect(lines).toEqual([
			'  │ one',
			'  │ two',
			'  │ thr',
			'  [warn] build output was truncated by the sandbox host; relaying what follows',
			'  │ ',
			'  │ last',
		])
	})

	test('a sandbox checkpoint settles failed on reconcile and cancel, without a platform call', async () => {
		const { box, control } = deployHarness()
		const reference = {
			runId: 'run-1',
			externalId: 'sandbox:sb1:run-1',
			environment: devEnvironment(),
			providerState: { sandboxId: 'sb1', runId: 'run-1', buildSessionId: 'session-build' },
			signal: signal(),
		}
		const logs: string[] = []
		const reconcile = control.reconcile
		if (reconcile === undefined) throw new Error('the Zerops provider reconciles')
		expect(await reconcile({ ...reference, log: async (line) => void logs.push(line) })).toEqual({ state: 'failed' })
		expect(logs).toEqual(['deploy interrupted: Control stopped while it deployed into the workspace sandbox; bind the workspace again'])
		expect(await control.cancel?.(reference)).toEqual({ state: 'settled', outcome: 'failed' })
		expect(box.requests).toEqual([])
	})

	test('a cancel during the build stops the build process', async () => {
		const controller = new AbortController()
		const box = new FakeBox({ buildOutput: ['one\n', 'two\n', 'three\n'] })
		box.addSandbox({ id: 'sb1' })
		const { control } = harness(box)
		const events = freshEvents()
		const input = deployInput(events, { signal: controller.signal })
		const outcome = await control.deploy({
			...input,
			events: {
				...input.events,
				log: (line) => {
					events.logs.push(line)
					if (line === '  │ one') controller.abort()
				},
			},
		}).catch((error: unknown) => error)
		expect(outcome).toBeInstanceOf(Error)
		await Bun.sleep(10)
		expect(box.commands()).toContainEqual(['/bin/sh', `/var/lib/fabrika/bin/${(await readSandboxScripts()).version}/stop.sh`, 'build'])
	})
})

describe('dev environment registration', () => {
	const prepare = (control: Harness['control'], environment: ProviderEnvironment) => {
		const preparation = control.namespaces?.prepareRegistration
		if (preparation === undefined) throw new Error('the Zerops provider prepares registrations')
		return preparation({
			registration: { app: { id: 'notes', source: { repoUrl: 'https://github.com/acme/notes', ref: 'main' } }, environment },
			signal: signal(),
		})
	}

	test('imports no service and stores the sandbox target', async () => {
		const { control, box } = harness()
		const registered = await prepare(control, devEnvironment({ target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: {} } }))
		expect(registered.environment.target).toEqual({ provider: 'zerops', version: 2, payload: { kind: 'devSandboxes' } })
		expect(zeropsStoredTargetCodec.decode(registered.environment.target.payload)).toEqual({ kind: 'devSandboxes' })
		expect(box.requests).toEqual([])
	})

	test("claims no Zerops service: the namespace's sandbox host runs every workspace", () => {
		const { control } = harness()
		const app = { id: 'notes', source: { repoUrl: 'https://github.com/acme/notes', ref: 'main' } }
		expect(compileFabrikaManifest(devConfig(), 'dev', DESCRIPTOR).target.importDocument.services.length).toBeGreaterThan(0)
		expect(control.namespaces?.registrationResourceClaims({ app, environment: devEnvironment() })).toEqual([])
		expect(control.namespaces?.registrationResourceClaims({ app, environment: devEnvironment({ kind: 'standard' }) })).not.toEqual([])
	})

	test('refuses object storage and a zerops-subdomain namespace', async () => {
		const { control } = harness()
		await expect(prepare(control, devEnvironment({}, devConfig([{ hostname: 'notesfiles', type: 'object-storage', objectStorageSize: 1 }]))))
			.rejects.toThrow('which have no object storage')
		await expect(prepare(control, devEnvironment({ namespace: namespace({ publicAccess: 'zerops-subdomain' }) }))).rejects.toThrow(
			'zerops: a dev environment serves each workspace on its own host, so namespace `apps-dev` needs custom-domain public access',
		)
	})

	test('refuses a contract that scans its uploads', () => {
		const manifest = compileFabrikaManifest(devConfig(), 'dev', DESCRIPTOR)
		expect(() => assertSandboxArtifact(manifest, { scan: true })).toThrow(
			'zerops: a dev environment runs in workspace sandboxes, which have no ClamAV scan; the contract scans uploads (scan: true)',
		)
		expect(() => assertSandboxArtifact(manifest)).not.toThrow()
	})

	test('a secret of a dev environment is refused, and its deletion is a no-op', async () => {
		const { control } = harness()
		const secrets = control.secrets
		if (secrets === undefined) throw new Error('the Zerops provider stores secrets')
		await expect(secrets.put({ environment: devEnvironment(), name: 'API_TOKEN', value: 'x' })).rejects.toBeInstanceOf(ProviderSecretError)
		await secrets.delete({ environment: devEnvironment(), name: 'API_TOKEN' })
	})
})
