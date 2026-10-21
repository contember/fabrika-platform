// What `fabrika platform deploy --provider=zerops` must do, and in what order.
//
// Three of these tests exist because the property they pin cannot be observed any other way: the
// ORDER is a security property (ADR-0027), the fail-closed behaviour only shows up on a failure path,
// and idempotence is a claim about the SECOND run.

import { FABRIKA_SERVICE_TABLE_DIGEST, IAM_PROXY_SECRET_VARIABLE, installationTableDigest } from '@fabrika/auth-core'
import { IAM_APP_ID, IAM_APP_SCHEMA } from '@fabrika/iam-contract'
import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import {
	contractProxyTable,
	FABRIKA_PROXY_MANIFEST_JSON,
	type InstallationProxyApp,
	isApplicationEntry,
	parseProxyManifestJson,
	type ProxyManifest,
} from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { notesArtifact } from '../../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { ZeropsApi } from '../../index'
import { deployPlatform, PLATFORM_CONCURRENT_DEPLOY, PLATFORM_DATABASE_BACKUP_PERIOD, PLATFORM_SEQUENTIAL_DEPLOY } from '../deploy'
import { parsePlatformDeployArgs, type PlatformDeployInput } from '../deploy-options'
import { recordingDeployLog } from '../log'
import type { McpClient } from '../mcp'
import { fakeSourceCollaborators } from './fake-platform-source'
import {
	FAKE_DAILY_BACKUP_PERIOD,
	FAKE_DEFAULT_RETENTION,
	type FakeBackup,
	type FakeZerops,
	fakeZerops,
	platformServices,
	SUBDOMAINS,
} from './fake-zerops'

/** The platform app `id` of a parsed manifest; every platform service is an installation entry with its table. */
const tableAppOf = (manifest: ProxyManifest | null, id: string): InstallationProxyApp | undefined => {
	const app = manifest?.apps.find((entry) => entry.id === id)
	return app === undefined || isApplicationEntry(app) ? undefined : app
}

const oauthRows = (app: InstallationProxyApp | undefined) => app?.endpoints.filter((row) => row.callers.some((caller) => caller === 'oauth')) ?? []

const PROJECT = { projectId: 'proj-1', projectName: 'fabrika-test' }

const IAM_HOST = 'proxy-292c-8080.prg1.zerops.app'
const CONSOLE_HOST = 'proxy-292c-8082.prg1.zerops.app'
const OPERATIONS_HOST = 'proxy-292c-8083.prg1.zerops.app'

/** The manifest copy an older release left in the proxy's variable, with stale platform entries and a hand-placed one. */
const legacyManifest = JSON.stringify({
	apps: [
		{ id: 'iam-local', hosts: [IAM_HOST], upstream: 'iam:3000', scheme: 'https', installation: true, endpoints: [], reservedPrefixes: [] },
		{ id: 'vozka', hosts: [CONSOLE_HOST], upstream: 'control:3000', scheme: 'https', installation: true, endpoints: [], reservedPrefixes: [] },
		{
			id: 'operations',
			hosts: [OPERATIONS_HOST],
			upstream: 'operations:3000',
			scheme: 'https',
			installation: true,
			endpoints: [],
			reservedPrefixes: [],
		},
		{ id: 'notes', hosts: ['proxy-292c-8084.prg1.zerops.app'], upstream: 'notesapi:3000', scheme: 'https', ...contractProxyTable(notesArtifact) },
	],
})

const input = (overrides: Partial<PlatformDeployInput> = {}): PlatformDeployInput => ({
	project: { kind: 'id', projectId: PROJECT.projectId },
	accessToken: 'zerops-token',
	environment: 'stage',
	scheme: 'https',
	iamAdminKey: 'px_admin',
	sourceDir: '.',
	dryRun: false,
	...overrides,
})

interface Harness {
	readonly zerops: FakeZerops
	readonly reconciled: SchemaReconcileInput[]
	readonly log: ReturnType<typeof recordingDeployLog>
	run(overrides?: Partial<PlatformDeployInput>): Promise<void>
}

const harness = (proxyEnv: Readonly<Record<string, string>> = {}, databaseBackup?: FakeBackup): Harness => {
	const zerops = fakeZerops({
		...PROJECT,
		services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, ...proxyEnv } })
			.map((service) => (service.name === 'db' && databaseBackup !== undefined ? { ...service, backup: databaseBackup } : service)),
	})
	const reconciled: SchemaReconcileInput[] = []
	const log = recordingDeployLog()
	return {
		zerops,
		reconciled,
		log,
		run: (overrides = {}) =>
			deployPlatform(input(overrides), {
				...fakeSourceCollaborators,
				uploadFetch: zerops.uploadFetch,
				api: zerops.api,
				reconcileSchema: async (call) => void reconciled.push(call),
				sleep: async () => {},
				log,
				signal: new AbortController().signal,
			}),
	}
}

/** The manifest the proxy serves: the data file of the archive its ACTIVE version was built from. */
const manifestOf = async (zerops: FakeZerops): Promise<string> => (await zerops.servedFile('proxy', 'proxy.manifest.json')) ?? ''

/** How many polls a build that will SUCCEED is held at `BUILDING` once every build has been triggered. */
const SLOW_BUILD_POLLS = 5

/**
 * A sleep that yields to the MACROTASK queue, which is what makes an abandoned build observable.
 *
 * With `async () => {}` every poll is a microtask, and the microtask queue drains completely before an
 * awaiting test body resumes — so a build nobody is waiting for still finishes before the assertion,
 * and `Promise.all` would pass a test written to catch it. A real timer hop cannot be drained that way.
 */
const yieldToTimer = (): Promise<void> => new Promise((settle) => void setTimeout(settle, 0))

/**
 * A fake that makes the concurrent stage's two properties observable from outside.
 *
 * **Started together.** No concurrent build reaches a terminal status until all of them have been
 * triggered, so under a sequential loop iam's poll would run out of attempts — the test fails rather
 * than quietly passing on microtask ordering.
 *
 * **Followed to their end.** With `slowPolls`, a build that will FAIL answers on its first poll while
 * one that will succeed is held at `BUILDING` for several more, each behind a real timer hop.
 * `Promise.allSettled` waits for it and logs its `ACTIVE` line; `Promise.all` would surface the
 * failure with the other still building and nobody polling it, which is exactly the
 * abandoned-build case — and its `ACTIVE` line is then missing when the rejection is asserted.
 */
const gatedBuilds = (fixture: Harness, slowPolls = 0): ZeropsApi => {
	const polls = new Map<string, number>()
	return {
		...fixture.zerops.api,
		getAppVersion: async (call) => {
			const version = await fixture.zerops.api.getAppVersion(call)
			const service = PLATFORM_CONCURRENT_DEPLOY.find((hostname) => call.appVersionId.startsWith(`${hostname}-v`))
			if (service === undefined) {
				return version
			}
			const allTriggered = PLATFORM_CONCURRENT_DEPLOY.every((hostname) => fixture.zerops.calls.includes(`deploy:${hostname}`))
			const seen = (polls.get(service) ?? 0) + 1
			polls.set(service, seen)
			return !allTriggered || (version.status === 'ACTIVE' && seen <= slowPolls) ? { ...version, status: 'BUILDING' } : version
		},
	}
}

const runWithGatedBuilds = (fixture: Harness, slowPolls = 0): Promise<void> =>
	deployPlatform(input(), {
		...fakeSourceCollaborators,
		api: gatedBuilds(fixture, slowPolls),
		reconcileSchema: async (call) => void fixture.reconciled.push(call),
		sleep: () => yieldToTimer(),
		log: fixture.log,
		signal: new AbortController().signal,
	})

describe('the order', () => {
	test('builds iam and operations AT ONCE, then proxy, then control', async () => {
		// Neither calls a sibling at boot and none reads a variable another's build needs, so the
		// order among them was arbitrary — and paying for it sequentially cost about 3 min 45 s of a
		// ~9 min 35 s warm roll (two measured runs, 2026-08-21).
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await runWithGatedBuilds(fixture)
		const deploys = fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))
		expect([...deploys.slice(0, 2)].sort()).toEqual(['deploy:iam', 'deploy:operations'])
		expect(deploys.slice(2)).toEqual(['deploy:proxy', 'deploy:control'])
		expect(PLATFORM_CONCURRENT_DEPLOY).toEqual(['iam', 'operations'])
		expect(PLATFORM_SEQUENTIAL_DEPLOY).toEqual(['proxy', 'control'])
	})

	test('a failure in the concurrent stage names that service, and the other build is still followed to its end', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.failDeploy('operations')
		// operations fails on its first poll; iam needs several more, each behind a timer hop. An
		// abandoned build keeps writing app versions after the command has exited — `allSettled` prevents it.
		await expect(runWithGatedBuilds(fixture, SLOW_BUILD_POLLS)).rejects.toThrow('`operations` deploy operations-v5 finished as DEPLOY_FAILED')
		expect(fixture.log.lines).toContain('info: iam: ACTIVE')
		expect(fixture.zerops.calls).not.toContain('deploy:proxy')
		expect(fixture.zerops.calls).not.toContain('deploy:control')
	})

	test('TWO failures are both reported, and the command dies of the first in the stage order', async () => {
		// `allSettled` collects a second rejection that `all` would drop on the floor: a run that named one
		// broken service and stayed silent about the other buys the operator a second failed roll.
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.failDeploy('iam')
		fixture.zerops.failDeploy('operations')
		await expect(runWithGatedBuilds(fixture)).rejects.toThrow('`iam` deploy iam-v5 finished as DEPLOY_FAILED')
		expect(fixture.log.lines).toContain('warn: zerops: the `iam` deploy iam-v5 finished as DEPLOY_FAILED')
		expect(fixture.log.lines).toContain('warn: zerops: the `operations` deploy operations-v5 finished as DEPLOY_FAILED')
	})

	test('warns once about a leftover `source` service and deploys without touching it', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: [
				...platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest } }),
				{ name: 'source', id: 'svc-source', sequence: 4, env: { GITHUB_APP_CREDENTIALS_V2_LEFTOVER: 'must-not-be-read' } },
			],
		})
		const log = recordingDeployLog()
		await deployPlatform(input(), {
			...fakeSourceCollaborators,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log,
			signal: new AbortController().signal,
		})
		expect(log.lines.filter((line) => line.startsWith('warn: ') && line.includes('`source` service from an earlier layout'))).toHaveLength(1)
		expect(zerops.timeline.filter((entry) => entry.split(':')[1] === 'source')).toEqual([])
		expect(log.lines.join('\n')).not.toContain('must-not-be-read')
	})

	// Found by running `platform install` on an empty project (2026-08-10): registering the console talks
	// to IAM over its PUBLIC host, so on a first bring-up it 502s until the proxy is published. The
	// default fixture models an already-published proxy — which is exactly the state that hid this — so
	// this one unpublishes it.
	test('publishes the public entry point BEFORE it registers the console', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest } })
				.map((service) => service.name === 'proxy' ? { ...service, subdomainAccess: false } : service),
		})
		let publishedFirst: boolean | undefined
		await deployPlatform(input(), {
			...fakeSourceCollaborators,
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
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		const proxy = fixture.zerops.calls.indexOf('deploy:proxy')
		const control = fixture.zerops.calls.indexOf('deploy:control')
		expect(proxy).toBeGreaterThanOrEqual(0)
		expect(proxy).toBeLessThan(control)
	})

	test('writes EVERY variable before it deploys ANY service', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
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
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.zerops.calls.indexOf('env:control:ENVIRONMENT')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:control'))
		expect(fixture.zerops.calls.indexOf('env:iam:ENVIRONMENT')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:iam'))
	})

	test('registers the console and IAM, and ensures the entry point only after the sequence has landed', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.env('proxy').delete('zeropsSubdomain')
		fixture.zerops.env('proxy').set('zeropsSubdomain', SUBDOMAINS)
		await fixture.run()
		expect(fixture.reconciled).toHaveLength(2)
		expect(fixture.reconciled[0]?.app).toBe('vozka')
		expect(fixture.reconciled[0]?.url).toBe(`https://${IAM_HOST}`)
		expect(fixture.reconciled[0]?.returnOrigins).toEqual([`https://${CONSOLE_HOST}`])
		expect(fixture.reconciled[0]?.adminKey).toBe('px_admin')
		// IAM's own vocabulary, beside the console's (ADR-0058), with no return origin.
		expect(fixture.reconciled[1]).toMatchObject({ app: IAM_APP_ID, url: `https://${IAM_HOST}`, schema: IAM_APP_SCHEMA, adminKey: 'px_admin' })
		expect(fixture.reconciled[1]?.returnOrigins).toBeUndefined()
	})

	test('refuses `local` when the console serves a public origin, before it writes anything', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await expect(fixture.run({ environment: 'local' })).rejects.toThrow('ENVIRONMENT=local is refused')
		expect(fixture.zerops.calls).toEqual([])
	})
})

describe('fail closed', () => {
	test('a manifest that cannot be applied never lets new code reach the previous manifest', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		const previous = await manifestOf(fixture.zerops)
		fixture.zerops.calls.length = 0
		fixture.zerops.failDeploy('proxy')
		await expect(fixture.run()).rejects.toThrow('finished as DEPLOY_FAILED')
		expect(fixture.zerops.calls).not.toContain('deploy:control')
		expect(await manifestOf(fixture.zerops)).toBe(previous)
	})

	test('a failed deploy stops the sequence, so control never lands behind an unbuilt proxy', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.failDeploy('proxy')
		await expect(fixture.run()).rejects.toThrow('finished as DEPLOY_FAILED')
		expect(fixture.zerops.calls).not.toContain('deploy:control')
		expect(fixture.reconciled).toEqual([])
	})

	test('a missing platform service is an error naming all of them, not a silent partial deploy', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: [{ name: 'db', id: 'svc-db' }, { name: 'iam', id: 'svc-iam' }],
		})
		await expect(
			deployPlatform(input(), {
				...fakeSourceCollaborators,
				api: zerops.api,
				reconcileSchema: async () => {},
				sleep: async () => {},
				log: recordingDeployLog(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('has no operations, proxy, control service')
	})
})

describe('idempotence', () => {
	test('a second run writes only the secret it cannot read back, publishes nothing, and leaves the manifest byte-identical', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		const afterFirst = await manifestOf(fixture.zerops)
		expect(fixture.zerops.calls.some((call) => call.startsWith('env:'))).toBe(true)

		fixture.zerops.calls.length = 0
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call.startsWith('env'))).toEqual([
			`env:iam:${IAM_PROXY_SECRET_VARIABLE}`,
			`env:proxy:${IAM_PROXY_SECRET_VARIABLE}`,
		])
		expect(fixture.zerops.calls.filter((call) => call.startsWith('subdomain:'))).toEqual([])
		expect(fixture.zerops.calls.filter((call) => call.startsWith('backup:'))).toEqual([])
		expect(await manifestOf(fixture.zerops)).toBe(afterFirst)
		// Deploying IS what a re-run does; it is the configuration that must not move.
		expect(fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))).toHaveLength(4)
	})

	test('a subdomain someone turned off comes back, and one already on is left alone', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.zerops.calls).not.toContain('subdomain:proxy')

		const off = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest } })
				.map((service) => (service.name === 'proxy' ? { ...service, subdomainAccess: false } : service)),
		})
		await deployPlatform(input(), {
			api: off.api,
			...fakeSourceCollaborators,
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
	test('the proxy serves the platform apps alone, and the variable an older release wrote is deleted before it builds', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		const manifest = parseProxyManifestJson(await manifestOf(fixture.zerops))
		expect(manifest?.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations'])
		// The drift backlog 58 exists for: the live console was one `public` rule.
		expect(tableAppOf(manifest, 'vozka')?.endpoints.length).toBeGreaterThan(1)
		expect(fixture.zerops.env('proxy').has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
		expect(fixture.zerops.calls).not.toContain(`env:proxy:${FABRIKA_PROXY_MANIFEST_JSON}`)
		expect(fixture.zerops.calls.indexOf(`env-delete:proxy:${FABRIKA_PROXY_MANIFEST_JSON}`)).toBeGreaterThanOrEqual(0)
		expect(fixture.zerops.calls.indexOf(`env-delete:proxy:${FABRIKA_PROXY_MANIFEST_JSON}`)).toBeLessThan(fixture.zerops.calls.indexOf('deploy:iam'))
	})

	test('a variable this build cannot parse is deleted unread', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: '{"apps":[{"id":"notes"}]}' })
		await fixture.run()
		expect(parseProxyManifestJson(await manifestOf(fixture.zerops))?.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations'])
		expect(fixture.zerops.env('proxy').has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
	})

	test('a proxy without the variable deletes nothing', async () => {
		const fixture = harness()
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call.startsWith('env-delete:'))).toEqual([])
	})

	test('the per-installation origins every service needs, and no credential but the derived IAM proxy secret', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.zerops.env('iam').get('ISSUER')).toBe(`https://${IAM_HOST}`)
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_ADMIN_ORIGINS')).toBeUndefined()
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_DOMAIN')).toBe(CONSOLE_HOST)
		expect(fixture.zerops.env('control').get('OPERATIONS_ARTIFACT_ORIGIN')).toBe(`https://${OPERATIONS_HOST}`)
		// The project no deployment namespace may adopt.
		expect(fixture.zerops.env('control').get('FABRIKA_ZEROPS_PLATFORM_PROJECT_ID')).toBe(PROJECT.projectId)
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_PUBLIC_HOST')).toBe(OPERATIONS_HOST)
		// The proxy compares this byte-for-byte against a token's `iss`, so it is the PUBLIC issuer.
		expect(fixture.zerops.env('proxy').get('FABRIKA_IAM_ISSUER')).toBe(`https://${IAM_HOST}`)
		expect(fixture.zerops.env('proxy').get('FABRIKA_PROXY_SESSION_OWNER_JSON')).toBe(
			JSON.stringify({ issuer: `https://${IAM_HOST}`, upstream: 'iam:3000' }),
		)
		expect(fixture.zerops.calls.indexOf('env:proxy:FABRIKA_PROXY_SESSION_OWNER_JSON')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:proxy'))
		for (const service of ['iam', 'operations', 'control', 'proxy']) {
			expect(fixture.zerops.env(service).get('ENVIRONMENT')).toBe('stage')
		}
		const written = new Set(fixture.zerops.calls.filter((call) => call.startsWith('env:')).map((call) => call.split(':')[2]))
		written.delete(IAM_PROXY_SECRET_VARIABLE)
		for (const key of written) {
			expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/)
		}
	})

	test('explicit hosts make it a custom-domain installation, which publishes no subdomain', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest } })
				.map((service) => (service.name === 'proxy' ? { ...service, subdomainAccess: false } : service)),
		})
		await deployPlatform(
			input({ hosts: { iam: 'iam.example.com', control: 'console.example.com', operations: 'errors.example.com' } }),
			{
				api: zerops.api,
				...fakeSourceCollaborators,
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

describe('the IAM proxy secret', () => {
	const expected = createHmac('sha256', 'px_admin').update('fabrika-installation-proxy-secret:iam').digest('hex')

	test('is HMAC-SHA256 of the label keyed by the IAM admin key, written SENSITIVE to proxy and iam before any deploy', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		for (const service of ['iam', 'proxy']) {
			expect(fixture.zerops.env(service).get(IAM_PROXY_SECRET_VARIABLE)).toBe(expected)
			expect(fixture.zerops.sensitive(service).has(IAM_PROXY_SECRET_VARIABLE)).toBe(true)
			expect(fixture.zerops.calls.indexOf(`env:${service}:${IAM_PROXY_SECRET_VARIABLE}`)).toBeLessThan(fixture.zerops.calls.indexOf('deploy:iam'))
		}
		for (const service of ['operations', 'control']) {
			expect(fixture.zerops.env(service).has(IAM_PROXY_SECRET_VARIABLE)).toBe(false)
		}
	})

	test('is rewritten on every deploy, and another admin key derives another secret', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		await fixture.run({ iamAdminKey: 'px_other_admin' })
		const rotated = createHmac('sha256', 'px_other_admin').update('fabrika-installation-proxy-secret:iam').digest('hex')
		expect(rotated).not.toBe(expected)
		expect(fixture.zerops.env('iam').get(IAM_PROXY_SECRET_VARIABLE)).toBe(rotated)
		expect(fixture.zerops.env('proxy').get(IAM_PROXY_SECRET_VARIABLE)).toBe(rotated)
	})

	test('is never logged', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.log.lines.some((line) => line.includes(IAM_PROXY_SECRET_VARIABLE))).toBe(true)
		expect(fixture.log.lines.some((line) => line.includes(expected))).toBe(false)
	})
})

describe('an installation an older release wrote, every variable sensitive', () => {
	const olderInstallation = (sensitiveManifest: boolean) =>
		fakeZerops({
			...PROJECT,
			services: platformServices({
				proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest, ENVIRONMENT: 'stage' },
				control: { ENVIRONMENT: 'stage' },
			}).map((service) => {
				const sensitive = Object.keys(service.env ?? {}).filter((key) => key !== 'zeropsSubdomain')
				return {
					...service,
					sensitive: sensitiveManifest ? sensitive : sensitive.filter((key) => key !== FABRIKA_PROXY_MANIFEST_JSON),
				}
			}),
		})
	const deploy = (zerops: FakeZerops) =>
		deployPlatform(input(), {
			...fakeSourceCollaborators,
			uploadFetch: zerops.uploadFetch,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log: recordingDeployLog(),
			signal: new AbortController().signal,
		})

	test('rewrites each value it cannot read as a readable one, so the next deploy can compare it', async () => {
		const zerops = olderInstallation(false)

		await deploy(zerops)

		expect(zerops.calls).toContain('env:proxy:ENVIRONMENT')
		expect(zerops.calls).toContain('env:control:ENVIRONMENT')
		expect(zerops.sensitive('proxy').has('ENVIRONMENT')).toBe(false)
		expect(zerops.sensitive('control').has('ENVIRONMENT')).toBe(false)
	})

	test('deletes the manifest copy it cannot read, without sudo mode, and leaves no manifest variable behind', async () => {
		const zerops = olderInstallation(true)

		await deploy(zerops)

		expect(zerops.calls).toContain(`env-delete:proxy:${FABRIKA_PROXY_MANIFEST_JSON}`)
		expect(zerops.env('proxy').has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
		expect(zerops.sensitive('proxy').has(FABRIKA_PROXY_MANIFEST_JSON)).toBe(false)
		expect(parseProxyManifestJson(await zerops.servedFile('proxy', 'proxy.manifest.json') ?? '')?.apps.map((app) => app.id)).toEqual([
			'iam',
			'vozka',
			'operations',
		])
	})
})

describe('the write→deploy race', () => {
	test('a trigger that lands on a running userData synchronisation is retried, not lost', async () => {
		// Live-recorded: a deploy racing an env write dies on `userDataSyncRunning` and leaves the app
		// version stuck UPLOADING, which nothing recovers from. This command writes and then deploys, so
		// it is exactly the caller that race was recorded against.
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.blockTrigger('iam', 2)
		await fixture.run()
		expect(fixture.zerops.calls.filter((call) => call === 'blocked:iam')).toHaveLength(2)
		expect(fixture.zerops.calls).toContain('deploy:iam')
	})

	test('but only a bounded number of times, so a genuine failure still fails', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.blockTrigger('iam', 99)
		await expect(fixture.run()).rejects.toThrow('variable synchronisation still running')
		// Operations shares iam's stage and are triggered whatever iam does — what a failure
		// there must still stop is everything the sequence DOES order after it.
		expect(fixture.zerops.calls).not.toContain('deploy:proxy')
		expect(fixture.zerops.calls).not.toContain('deploy:control')
	})
})

describe('--dry-run', () => {
	test('reads everything and changes nothing', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run({ dryRun: true, iamAdminKey: '' })
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.reconciled).toEqual([])
		expect(await manifestOf(fixture.zerops)).toBe('')
		expect(fixture.zerops.env('proxy').get(FABRIKA_PROXY_MANIFEST_JSON)).toBe(legacyManifest)
		expect(fixture.log.lines.some((line) => line.includes('would write'))).toBe(true)
		expect(fixture.log.lines.some((line) => line.includes(`would remove ${FABRIKA_PROXY_MANIFEST_JSON}`))).toBe(true)
		expect(fixture.zerops.timeline).toContain('readbackup:db')
		expect(fixture.zerops.backup('db').backupPeriod).toBe(FAKE_DAILY_BACKUP_PERIOD)
		expect(fixture.log.lines).toContain(`info: db: backups would run on \`${PLATFORM_DATABASE_BACKUP_PERIOD}\`, were \`${FAKE_DAILY_BACKUP_PERIOD}\``)
	})
})

describe('the platform database backup schedule', () => {
	const OWN_RETENTION = { ...FAKE_DEFAULT_RETENTION, maxTotalFiles: 40, protectedTags: ['before-migration'], minMonthly: 12 }

	test('a daily schedule becomes hourly, sent with the default retention whole when the service has none of its own', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.zerops.backupWrites).toEqual([
			{ service: 'db', backupPeriod: PLATFORM_DATABASE_BACKUP_PERIOD, retentionPolicy: FAKE_DEFAULT_RETENTION },
		])
		expect(fixture.zerops.backup('db').backupPeriod).toBe(PLATFORM_DATABASE_BACKUP_PERIOD)
		expect(fixture.log.lines).toContain(`info: db: backups now run on \`${PLATFORM_DATABASE_BACKUP_PERIOD}\`, were \`${FAKE_DAILY_BACKUP_PERIOD}\``)
	})

	test("the service's own retention is sent back whole", async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest }, {
			backupPeriod: FAKE_DAILY_BACKUP_PERIOD,
			retentionPolicy: OWN_RETENTION,
		})
		await fixture.run()
		expect(fixture.zerops.backupWrites).toEqual([{ service: 'db', backupPeriod: PLATFORM_DATABASE_BACKUP_PERIOD, retentionPolicy: OWN_RETENTION }])
	})

	test('an hourly schedule is read and left alone', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest }, {
			backupPeriod: PLATFORM_DATABASE_BACKUP_PERIOD,
			retentionPolicy: OWN_RETENTION,
		})
		await fixture.run()
		expect(fixture.zerops.timeline).toContain('readbackup:db')
		expect(fixture.zerops.backupWrites).toEqual([])
		expect(fixture.log.lines).toContain(`info: db: backups already run on \`${PLATFORM_DATABASE_BACKUP_PERIOD}\``)
	})

	test('a period the read-back does not show is a warning, after every service is deployed and registered', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.ignoreBackupPeriod('db')
		await fixture.run()
		expect(fixture.zerops.backupWrites).toHaveLength(1)
		expect(fixture.zerops.calls).toContain('deploy:control')
		expect(fixture.reconciled).toHaveLength(2)
		expect(fixture.log.lines).toContain(
			`warn: db: backups were set to \`${PLATFORM_DATABASE_BACKUP_PERIOD}\` but read back \`${FAKE_DAILY_BACKUP_PERIOD}\`; check the schedule by hand`,
		)
	})

	test('a refused write is a warning, not a failed deploy', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		fixture.zerops.refuseBackupConfig('db')
		await fixture.run()
		expect(fixture.zerops.calls).toContain('deploy:control')
		expect(fixture.log.lines.some((line) => line.startsWith('warn: db: the backup schedule was not set'))).toBe(true)
	})

	test('a schedule someone chose is kept', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest }, { backupPeriod: '*/15 * * * *' })
		await fixture.run()
		expect(fixture.zerops.backupWrites).toEqual([])
		expect(fixture.log.lines).toContain('info: db: backups keep the schedule `*/15 * * * *` someone chose instead of the daily default')
	})

	test('an installation whose Operations shares `db` keeps its schedule', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS } }).filter((service) => service.name !== 'operationsdb'),
		})
		const log = recordingDeployLog()
		await deployPlatform(input(), {
			...fakeSourceCollaborators,
			uploadFetch: zerops.uploadFetch,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log,
			signal: new AbortController().signal,
		})
		expect(zerops.timeline).not.toContain('readbackup:db')
		expect(zerops.backupWrites).toEqual([])
		expect(log.lines.some((line) => line.startsWith('warn: db: backups keep their schedule — Operations shares this database'))).toBe(true)
	})

	test('an installation without its database is refused before anything is written', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { zeropsSubdomain: SUBDOMAINS } }).filter((service) => service.name !== 'db'),
		})
		await expect(
			deployPlatform(input(), {
				...fakeSourceCollaborators,
				api: zerops.api,
				reconcileSchema: async () => {},
				sleep: async () => {},
				log: recordingDeployLog(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('has no db service')
		expect(zerops.calls).toEqual([])
	})
})

describe('MCP authoring', () => {
	const CLAUDE: McpClient = {
		provider: 'claude',
		clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
		redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
	}
	const MCP_RESOURCE = `https://${CONSOLE_HOST}/mcp`

	test('enabled: the console admits OAuth bearers on `/mcp` and registers the resource IAM issues for', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run({ mcpClients: [CLAUDE] })
		const console_ = tableAppOf(parseProxyManifestJson(await manifestOf(fixture.zerops)), 'vozka')
		expect(oauthRows(console_).map((row) => [row.path, row.oauth?.scopes])).toEqual([['/mcp', ['authoring']]])
		expect(console_?.oauthResources).toEqual([{
			resource: MCP_RESOURCE,
			resourceMetadata: `https://${CONSOLE_HOST}/.well-known/oauth-protected-resource/mcp`,
			authorizationServers: [`https://${IAM_HOST}`],
			scopesSupported: ['authoring'],
		}])
	})

	test('enabled: IAM gets an OAuth config for exactly that resource, before it deploys', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run({ mcpClients: [CLAUDE] })
		expect(JSON.parse(fixture.zerops.env('iam').get('FABRIKA_IAM_OAUTH_CONFIG') ?? '')).toEqual({
			clients: [CLAUDE],
			resources: [{
				app: 'vozka',
				resource: MCP_RESOURCE,
				defaultScopes: ['authoring'],
				scopeGrants: [{
					scope: 'authoring',
					permissions: [
						{ action: 'source.workspace.read' },
						{ action: 'source.workspace.write' },
						{ action: 'source.pull-request.create' },
						{ action: 'deploy.trigger' },
						{ action: 'deploy.read' },
					],
				}],
			}],
		})
		expect(fixture.zerops.calls.indexOf('env:iam:FABRIKA_IAM_OAUTH_CONFIG')).toBeLessThan(fixture.zerops.calls.indexOf('deploy:iam'))
	})

	test('enabled: the value is never logged', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run({ mcpClients: [CLAUDE] })
		expect(fixture.log.lines.some((line) => line.includes('redirectUris') || line.includes(CLAUDE.redirectUris[0] ?? '-'))).toBe(false)
	})

	test('enabled or off: Control gets the digest of the table the proxy publishes, before it deploys', async () => {
		const digests: string[] = []
		for (const overrides of [{ mcpClients: [CLAUDE] }, {}]) {
			const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
			await fixture.run(overrides)
			const console_ = tableAppOf(parseProxyManifestJson(await manifestOf(fixture.zerops)), 'vozka')
			if (console_ === undefined) throw new Error('the console has no table')
			const digest = fixture.zerops.env('control').get(FABRIKA_SERVICE_TABLE_DIGEST)
			expect(digest).toBe(installationTableDigest(console_))
			expect(fixture.zerops.calls.indexOf(`env:control:${FABRIKA_SERVICE_TABLE_DIGEST}`)).toBeLessThan(fixture.zerops.calls.indexOf('deploy:control'))
			digests.push(digest ?? '')
		}
		expect(new Set(digests).size).toBe(2)
	})

	test('off: no OAuth row, no registered resource, and no IAM OAuth config written', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		const console_ = tableAppOf(parseProxyManifestJson(await manifestOf(fixture.zerops)), 'vozka')
		expect(console_).toBeDefined()
		expect(oauthRows(console_)).toEqual([])
		expect(console_?.oauthResources).toBeUndefined()
		expect(fixture.zerops.calls).not.toContain('env:iam:FABRIKA_IAM_OAUTH_CONFIG')
	})

	test('off: an IAM OAuth config the operator set is left as it is, with a warning naming it', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({
				proxy: { zeropsSubdomain: SUBDOMAINS, [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest },
				iam: { FABRIKA_IAM_OAUTH_CONFIG: 'operator-owned' },
			}),
		})
		const log = recordingDeployLog()
		await deployPlatform(input(), {
			...fakeSourceCollaborators,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log,
			signal: new AbortController().signal,
		})
		expect(zerops.env('iam').get('FABRIKA_IAM_OAUTH_CONFIG')).toBe('operator-owned')
		expect(log.lines.some((line) => line.startsWith('warn:') && line.includes('FABRIKA_IAM_OAUTH_CONFIG'))).toBe(true)
		expect(log.lines.some((line) => line.includes('operator-owned'))).toBe(false)
	})

	test('off and never set: no warning', async () => {
		const fixture = harness({ [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest })
		await fixture.run()
		expect(fixture.log.lines.some((line) => line.includes('FABRIKA_IAM_OAUTH_CONFIG'))).toBe(false)
	})

	test('a mixed-case custom host yields the resource Control derives from its own domain', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: platformServices({ proxy: { [FABRIKA_PROXY_MANIFEST_JSON]: legacyManifest } }),
		})
		const parsed = parsePlatformDeployArgs(
			[
				'--source-dir=.',
				'--project-id=proj-1',
				'--env=stage',
				'--iam-host=IAM.Example.com',
				'--console-host=Console.Example.com',
				'--operations-host=Errors.Example.com',
			],
			{
				FABRIKA_ZEROPS_ACCESS_TOKEN: 'zerops-token',
				FABRIKA_IAM_PROVISIONING_KEY: 'px_admin',
				FABRIKA_PLATFORM_MCP_CLIENTS_JSON: JSON.stringify([CLAUDE]),
			},
		)
		await deployPlatform(parsed, {
			...fakeSourceCollaborators,
			uploadFetch: zerops.uploadFetch,
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log: recordingDeployLog(),
			signal: new AbortController().signal,
		})
		// Control's `controlPublicOrigin` is `new URL(origin).origin` over its `FABRIKA_CONTROL_DOMAIN`.
		const controlOrigin = new URL(`https://${zerops.env('control').get('FABRIKA_CONTROL_DOMAIN') ?? ''}`).origin
		const expected = `${controlOrigin}/mcp`
		expect(expected).toBe('https://console.example.com/mcp')
		const console_ = tableAppOf(parseProxyManifestJson(await manifestOf(zerops)), 'vozka')
		expect(console_?.oauthResources?.map((entry) => entry.resource)).toEqual([expected])
		expect(console_?.oauthResources?.[0]?.authorizationServers).toEqual(['https://iam.example.com'])
		expect(JSON.parse(zerops.env('iam').get('FABRIKA_IAM_OAUTH_CONFIG') ?? '')).toMatchObject({ resources: [{ resource: expected }] })
	})
})
