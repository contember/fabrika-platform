// What `fabrika platform deploy --provider=zerops` must do, and in what order.
//
// Three of these tests exist because the property they pin cannot be observed any other way: the
// ORDER is a security property (ADR-0027), the fail-closed behaviour only shows up on a failure path,
// and idempotence is a claim about the SECOND run.

import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { FABRIKA_PROXY_MANIFEST_JSON, parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { deployPlatform, PLATFORM_DEPLOY_ORDER } from '../deploy'
import type { PlatformDeployInput } from '../deploy-options'
import { recordingDeployLog } from '../log'
import { type FakeZerops, fakeZerops, platformServices, SUBDOMAINS } from './fake-zerops'

const PROJECT = { projectId: 'proj-1', projectName: 'fabrika-test' }

const IAM_HOST = 'proxy-292c-8080.prg1.zerops.app'
const CONSOLE_HOST = 'proxy-292c-8082.prg1.zerops.app'
const OPERATIONS_HOST = 'proxy-292c-8083.prg1.zerops.app'

/** The live manifest on `fabrika-test`: the three platform apps plus one APPLICATION the deploy must keep. */
const liveManifest = JSON.stringify({
	apps: [
		{ id: 'iam-local', hosts: [IAM_HOST], upstream: 'iam:3000', gates: { rules: [{ path: '/*', kind: 'public' }] }, scheme: 'https' },
		{ id: 'vozka', hosts: [CONSOLE_HOST], upstream: 'control:3000', gates: { rules: [{ path: '/*', kind: 'public' }] }, scheme: 'https' },
		{
			id: 'operations',
			hosts: [OPERATIONS_HOST],
			upstream: 'operations:3000',
			gates: { rules: [{ path: '/api/*/envelope/', kind: 'public' }] },
			scheme: 'https',
		},
		{
			id: 'notes',
			hosts: ['proxy-292c-8084.prg1.zerops.app'],
			upstream: 'notesapi:3000',
			gates: { rules: [{ path: '/*', kind: 'human' }] },
			scheme: 'https',
		},
	],
})

const input = (overrides: Partial<PlatformDeployInput> = {}): PlatformDeployInput => ({
	project: { kind: 'id', projectId: PROJECT.projectId },
	accessToken: 'zerops-token',
	environment: 'stage',
	scheme: 'https',
	iamAdminKey: 'px_admin',
	buildFromGit: 'https://github.com/contember/fabrika-platform',
	dryRun: false,
	...overrides,
})

interface Harness {
	readonly zerops: FakeZerops
	readonly reconciled: SchemaReconcileInput[]
	readonly log: ReturnType<typeof recordingDeployLog>
	run(overrides?: Partial<PlatformDeployInput>): Promise<void>
}

const harness = (proxyEnv: Readonly<Record<string, string>> = {}): Harness => {
	const zerops = fakeZerops({
		...PROJECT,
		services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, ...proxyEnv } }),
	})
	const reconciled: SchemaReconcileInput[] = []
	const log = recordingDeployLog()
	return {
		zerops,
		reconciled,
		log,
		run: (overrides = {}) =>
			deployPlatform(input(overrides), {
				api: zerops.api,
				reconcileSchema: async (call) => void reconciled.push(call),
				sleep: async () => {},
				log,
				signal: new AbortController().signal,
			}),
	}
}

const manifestOf = (zerops: FakeZerops): string => zerops.env('proxy').get(FABRIKA_PROXY_MANIFEST_JSON) ?? ''

describe('the order', () => {
	test('deploys IAM → Operations → source → proxy → control', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))).toEqual([
			'deploy:iam',
			'deploy:operations',
			'deploy:source',
			'deploy:proxy',
			'deploy:control',
		])
		expect(PLATFORM_DEPLOY_ORDER).toEqual(['iam', 'operations', 'source', 'proxy', 'control'])
	})

	// Found by running `platform install` on an empty project (2026-08-10): registering the console talks
	// to IAM over its PUBLIC host, so on a first bring-up it 502s until the proxy is published. The
	// default fixture models an already-published proxy — which is exactly the state that hid this — so
	// this one unpublishes it.
	test('publishes the public entry point BEFORE it registers the console', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest } })
				.map((service) => service.name === 'proxy' ? { ...service, subdomainAccess: false } : service),
		})
		let publishedFirst: boolean | undefined
		await deployPlatform(input(), {
			api: zerops.api,
			reconcileSchema: async () => void (publishedFirst = zerops.calls.includes('subdomain:proxy')),
			sleep: async () => {},
			log: recordingDeployLog(),
			signal: new AbortController().signal,
		})
		expect(zerops.calls).toContain('subdomain:proxy')
		expect(publishedFirst).toBe(true)
	})

	test('puts the PROXY ahead of control, because the application enforces nothing (ADR-0022)', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		const proxy = fixture.zerops.calls.indexOf('deploy:proxy')
		const control = fixture.zerops.calls.indexOf('deploy:control')
		expect(proxy).toBeGreaterThanOrEqual(0)
		expect(proxy).toBeLessThan(control)
	})

	test('writes EVERY variable before it deploys ANY service', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		const writes = fixture.zerops.calls.flatMap((call, index) => (call.startsWith('env:') ? [index] : []))
		const lastWrite = Math.max(...writes)
		const firstDeploy = fixture.zerops.calls.findIndex((call) => call.startsWith('deploy:'))
		expect(lastWrite).toBeGreaterThanOrEqual(0)
		expect(lastWrite).toBeLessThan(firstDeploy)
	})

	test('writes ENVIRONMENT before deploying the code that refuses `local` on a public host', async () => {
		// WU3's ordering constraint: `control` on the live installation pairs ENVIRONMENT=local with a
		// public host, so the next deploy of the refusal would fail its readiness gate unless the correct
		// name is already in place.
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		expect(fixture.zerops.calls.indexOf('env:control:ENVIRONMENT')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:control'))
		expect(fixture.zerops.calls.indexOf('env:iam:ENVIRONMENT')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:iam'))
	})

	test('registers the console and ensures the entry point only after the sequence has landed', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		fixture.zerops.env('proxy').delete('zeropsSubdomain')
		fixture.zerops.env('proxy').set('zeropsSubdomain', SUBDOMAINS)
		await fixture.run()
		expect(fixture.reconciled).toHaveLength(1)
		expect(fixture.reconciled[0]?.app).toBe('vozka')
		expect(fixture.reconciled[0]?.url).toBe(`https://${IAM_HOST}`)
		expect(fixture.reconciled[0]?.returnOrigins).toEqual([`https://${CONSOLE_HOST}`])
		expect(fixture.reconciled[0]?.adminKey).toBe('px_admin')
	})

	test('refuses `local` when the console serves a public origin, before it writes anything', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await expect(fixture.run({ environment: 'local' })).rejects.toThrow('ENVIRONMENT=local is refused')
		expect(fixture.zerops.calls).toEqual([])
	})
})

describe('fail closed', () => {
	test('a manifest that cannot be applied never lets new code reach the previous manifest', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		fixture.zerops.failWrite('proxy', FABRIKA_PROXY_MANIFEST_JSON)
		await expect(fixture.run()).rejects.toThrow()
		expect(fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))).toEqual([])
		expect(manifestOf(fixture.zerops)).toBe(liveManifest)
	})

	test('a failed deploy stops the sequence, so control never lands behind an unbuilt proxy', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		fixture.zerops.failDeploy('proxy')
		await expect(fixture.run()).rejects.toThrow('finished as DEPLOY_FAILED')
		expect(fixture.zerops.calls).not.toContain('deploy:control')
		expect(fixture.reconciled).toEqual([])
	})

	test('a live manifest this build cannot parse is refused rather than replaced', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: '{"apps":[{"id":"notes"}]}' })
		await expect(fixture.run()).rejects.toThrow('cannot be parsed by this build')
		expect(fixture.zerops.calls).toEqual([])
	})

	test('a missing platform service is an error naming all of them, not a silent partial deploy', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: [{ name: 'db', id: 'svc-db' }, { name: 'iam', id: 'svc-iam' }],
		})
		await expect(
			deployPlatform(input(), {
				api: zerops.api,
				reconcileSchema: async () => {},
				sleep: async () => {},
				log: recordingDeployLog(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('has no operations, source, proxy, control service')
	})
})

describe('idempotence', () => {
	test('a second run writes nothing, publishes nothing, and leaves the manifest byte-identical', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		const afterFirst = manifestOf(fixture.zerops)
		expect(fixture.zerops.calls.some((call) => call.startsWith('env:'))).toBe(true)

		fixture.zerops.calls.length = 0
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call.startsWith('env:'))).toEqual([])
		expect(fixture.zerops.calls.filter((call) => call.startsWith('subdomain:'))).toEqual([])
		expect(manifestOf(fixture.zerops)).toBe(afterFirst)
		// Deploying IS what a re-run does; it is the configuration that must not move.
		expect(fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))).toHaveLength(5)
	})

	test('a subdomain someone turned off comes back, and one already on is left alone', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		expect(fixture.zerops.calls).not.toContain('subdomain:proxy')

		const off = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest } })
				.map((service) => (service.name === 'proxy' ? { ...service, subdomainAccess: false } : service)),
		})
		await deployPlatform(input(), {
			api: off.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log: recordingDeployLog(),
			signal: new AbortController().signal,
		})
		expect(off.calls).toContain('subdomain:proxy')
		expect(off.subdomainAccess('proxy')).toBe(true)
	})
})

describe('what it writes', () => {
	test('the merged manifest keeps the application entry and adopts the platform gates', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		const manifest = parseProxyManifestJson(manifestOf(fixture.zerops))
		expect(manifest?.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations', 'notes'])
		// The drift backlog 58 exists for: the live console was one `public` rule.
		expect(manifest?.apps.find((app) => app.id === 'vozka')?.gates.rules.length).toBeGreaterThan(1)
		expect(manifest?.apps.find((app) => app.id === 'notes')?.upstream).toBe('notesapi:3000')
	})

	test('the per-installation origins every service needs, and no credential', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run()
		expect(fixture.zerops.env('iam').get('ISSUER')).toBe(`https://${IAM_HOST}`)
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_ADMIN_ORIGINS')).toBe(JSON.stringify([`https://${CONSOLE_HOST}`]))
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_DOMAIN')).toBe(CONSOLE_HOST)
		expect(fixture.zerops.env('control').get('OPERATIONS_ARTIFACT_ORIGIN')).toBe(`https://${OPERATIONS_HOST}`)
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_PUBLIC_HOST')).toBe(OPERATIONS_HOST)
		// The proxy compares this byte-for-byte against a token's `iss`, so it is the PUBLIC issuer.
		expect(fixture.zerops.env('proxy').get('FABRIKA_IAM_URL')).toBe(`https://${IAM_HOST}`)
		for (const service of ['iam', 'operations', 'control', 'proxy']) {
			expect(fixture.zerops.env(service).get('ENVIRONMENT')).toBe('stage')
		}
		const written = new Set(fixture.zerops.calls.filter((call) => call.startsWith('env:')).map((call) => call.split(':')[2]))
		for (const key of written) {
			expect(key).not.toMatch(/KEY$|TOKEN$|SECRET$|PASSWORD$/)
		}
	})

	test('explicit hosts make it a custom-domain installation, which publishes no subdomain', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest } })
				.map((service) => (service.name === 'proxy' ? { ...service, subdomainAccess: false } : service)),
		})
		await deployPlatform(
			input({ hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' } }),
			{
				api: zerops.api,
				reconcileSchema: async () => {},
				sleep: async () => {},
				log: recordingDeployLog(),
				signal: new AbortController().signal,
			},
		)
		expect(zerops.calls).not.toContain('subdomain:proxy')
		expect(zerops.env('iam').get('ISSUER')).toBe('https://iam.example.com')
	})
})

describe('the write→deploy race', () => {
	test('a trigger that lands on a running userData synchronisation is retried, not lost', async () => {
		// Live-recorded: a deploy racing an env write dies on `userDataSyncRunning` and leaves the app
		// version stuck UPLOADING, which nothing recovers from. This command writes and then deploys, so
		// it is exactly the caller that race was recorded against.
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		fixture.zerops.blockTrigger('iam', 2)
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call === 'blocked:iam')).toHaveLength(2)
		expect(fixture.zerops.calls).toContain('deploy:iam')
	})

	test('but only a bounded number of times, so a genuine failure still fails', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		fixture.zerops.blockTrigger('iam', 99)
		await expect(fixture.run()).rejects.toThrow('trigger-pipeline failed')
		expect(fixture.zerops.calls).not.toContain('deploy:operations')
	})
})

describe('--dry-run', () => {
	test('reads everything and changes nothing', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: liveManifest })
		await fixture.run({ dryRun: true, iamAdminKey: '' })
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.reconciled).toEqual([])
		expect(manifestOf(fixture.zerops)).toBe(liveManifest)
		expect(fixture.log.lines.some((line) => line.includes('would write'))).toBe(true)
	})
})
