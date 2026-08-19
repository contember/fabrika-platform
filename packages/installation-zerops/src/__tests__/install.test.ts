// What `fabrika platform install --provider=zerops` must do to a project the operator created empty.
//
// Four properties here cannot be observed any other way, and each is why its test exists: the ORDER of
// a bring-up (nothing may be written before the services exist, and nothing may be deployed before the
// proxy has published its ports), the SHAPES of six generated secrets (a wrong one boots a service that
// then refuses every request), which service each SHARED secret reaches (a mismatch is a 401 at 3am),
// and what never reaches a log line.

import type { SchemaReconcileInput } from '@fabrika/provider-contract'
import { FABRIKA_PROXY_MANIFEST_JSON, parseProxyManifestJson } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { generatedArtifacts } from '../../zerops/artifacts'
import { PLATFORM_DEPLOY_ORDER, type PlatformDeployService } from '../deploy'
import { GENERATED_SECRET_KEYS, installationServiceEnv, type InstallCollaborators, runInstall } from '../install'
import { parsePlatformInstallArgs, type PlatformInstallInput } from '../install-options'
import { recordingInitLog } from '../log'
import { generateInstallationSecrets } from '../secrets'
import { type FakeServiceSpec, type FakeZerops, fakeZerops, importedLightServices } from './fake-zerops'

const PROJECT = { projectId: 'proj-1', projectName: 'fabrika-fresh' }
const CLIENT_ID = 'client-1'

/** The hosts the proxy's six generated subdomains resolve to, keyed by the template's listener ports. */
const IAM_HOST = 'proxy-292c-8080.prg1.zerops.app'
const CONSOLE_HOST = 'proxy-292c-8082.prg1.zerops.app'
const OPERATIONS_HOST = 'proxy-292c-8083.prg1.zerops.app'

const input = (overrides: Partial<PlatformInstallInput> = {}): PlatformInstallInput => ({
	projectId: PROJECT.projectId,
	clientId: CLIENT_ID,
	accessToken: 'zerops-personal-access-token-that-must-never-be-printed',
	environment: 'stage',
	scheme: 'https',
	buildFromGit: 'https://github.com/contember/fabrika-platform',
	tier: 'light',
	...overrides,
})

interface Harness {
	readonly zerops: FakeZerops
	readonly reconciled: SchemaReconcileInput[]
	readonly log: ReturnType<typeof recordingInitLog>
	readonly asked: string[]
	run(overrides?: Partial<PlatformInstallInput>): Promise<void>
}

/** Every seam faked: no TTY, no network, no clock. An unlisted confirmation answers yes. */
const harness = (options: {
	readonly services?: readonly FakeServiceSpec[]
	readonly projectMode?: 'LIGHT' | 'SERIOUS'
	readonly confirms?: Record<string, boolean>
} = {}): Harness => {
	const zerops = fakeZerops({
		...PROJECT,
		projectMode: options.projectMode ?? 'LIGHT',
		services: options.services ?? [],
		bootstrap: { clientId: CLIENT_ID, imported: importedLightServices() },
	})
	const reconciled: SchemaReconcileInput[] = []
	const log = recordingInitLog()
	const asked: string[] = []
	const collaborators: InstallCollaborators = {
		api: zerops.api,
		reconcileSchema: async (call) => void reconciled.push(call),
		sleep: async () => {},
		log,
		prompts: {
			confirm: async (question) => {
				asked.push(question)
				return options.confirms?.[question] ?? true
			},
		},
		signal: new AbortController().signal,
	}
	return { zerops, reconciled, log, asked, run: (overrides = {}) => runInstall(input(overrides), collaborators) }
}

/** Every generated secret value that reached any service, so a test can hunt for it in the transcript. */
const writtenSecrets = (zerops: FakeZerops): Map<string, string> => {
	const values = new Map<string, string>()
	for (const [hostname, keys] of GENERATED_SECRET_KEYS) {
		for (const key of keys) {
			const value = zerops.env(hostname).get(key)
			if (value !== undefined) {
				values.set(`${hostname}.${key}`, value)
			}
		}
	}
	return values
}

describe('the sequence', () => {
	test('provisions, mints, builds the proxy, writes, and only then deploys', async () => {
		const fixture = harness()

		await fixture.run()

		const spine = fixture.zerops.calls.filter((call) =>
			call.startsWith('import:') || call.startsWith('token:') || call.startsWith('deploy:') || call.startsWith('subdomain:')
		)
		expect(spine).toEqual([
			'import:proj-1',
			'token:client-1',
			// Pass 1: the proxy alone, so it publishes the ports its public hostnames are named after.
			'deploy:proxy',
			// Pass 2, handed to `deployPlatform`: the order is a security property (ADR-0027).
			'deploy:iam',
			'deploy:operations',
			'deploy:source',
			'deploy:proxy',
			'deploy:control',
			'subdomain:proxy',
		])
	})

	test('waits on EVERY process the import returned before it reads or writes any environment', async () => {
		// Measured live (2026-08-10): `importServices` returns at once, and until a service leaves `NEW` it
		// has NO environment at all — not even the platform's generated keys. So the wait gates the reads
		// as much as the writes, and a `zeropsSubdomain` read before it would come back empty.
		const fixture = harness()

		await fixture.run()

		expect(fixture.zerops.importedProcesses).toHaveLength(12)
		for (const processId of fixture.zerops.importedProcesses) {
			expect(fixture.zerops.timeline).toContain(`process:${processId}`)
		}
		const lastProcess = Math.max(...fixture.zerops.timeline.flatMap((call, index) => (call.startsWith('process:') ? [index] : [])))
		const firstRead = fixture.zerops.timeline.findIndex((call) => call.startsWith('readenv:'))
		const firstWrite = fixture.zerops.timeline.findIndex((call) => call.startsWith('env:'))
		expect(lastProcess).toBeGreaterThanOrEqual(0)
		expect(firstRead).toBeGreaterThan(lastProcess)
		expect(firstWrite).toBeGreaterThan(lastProcess)
	})

	test("the import's per-service process count is the platform's, not one it assumed", async () => {
		const fixture = harness()

		await fixture.run()

		// Live: 1 process for each managed service, 2 for each runtime one. The command waits on whatever
		// it is handed rather than on a count it knows, which is why the fake hands it an uneven set.
		expect(fixture.zerops.importedProcesses.filter((id) => id.startsWith('process-import-db-'))).toHaveLength(1)
		expect(fixture.zerops.importedProcesses.filter((id) => id.startsWith('process-import-proxy-'))).toHaveLength(2)
	})

	test('applies the committed services-only provisioning document, byte for byte', async () => {
		const fixture = harness()

		await fixture.run()

		const committed = generatedArtifacts().find((artifact) => artifact.path.endsWith('platform-light.services.provision.zerops-import.yaml'))
		expect(committed).toBeDefined()
		expect(fixture.zerops.imports).toHaveLength(1)
		// The artifact carries a generated header; what is applied is its body, and it must be that body.
		expect(committed?.content).toEndWith(fixture.zerops.imports[0] ?? 'no import')
		expect(fixture.zerops.imports[0]).not.toContain('project:')
	})

	test('mints a token scoped to this ONE project, never the personal one it authenticated with', async () => {
		const fixture = harness()

		await fixture.run()

		expect(fixture.zerops.mintedTokens).toHaveLength(1)
		expect(fixture.zerops.env('control').get('FABRIKA_ZEROPS_ACCESS_TOKEN')).toBe(fixture.zerops.mintedTokens[0])
		expect(fixture.zerops.env('control').get('FABRIKA_ZEROPS_ACCESS_TOKEN')).not.toBe(input().accessToken)
	})
})

describe('pass 1', () => {
	test('writes exactly three variables on the proxy and nothing anywhere else, before the build', async () => {
		const fixture = harness()

		await fixture.run()

		const untilBuild = fixture.zerops.calls.slice(0, fixture.zerops.calls.indexOf('deploy:proxy'))
		expect(untilBuild.filter((call) => call.startsWith('env:'))).toEqual([
			'env:proxy:FABRIKA_PROXY_MANIFEST_JSON',
			'env:proxy:FABRIKA_IAM_URL',
			'env:proxy:FABRIKA_IAM_KEY',
		])
	})

	test('the manifest it builds with is the legal EMPTY one, and the deploy replaces it', async () => {
		const fixture = harness()
		const seen: string[] = []
		const api = fixture.zerops.api
		const traced = {
			...api,
			triggerPipeline: async (call: Parameters<typeof api.triggerPipeline>[0]) => {
				seen.push(fixture.zerops.env('proxy').get(FABRIKA_PROXY_MANIFEST_JSON) ?? '')
				return api.triggerPipeline(call)
			},
		}
		await runInstall(input(), {
			api: traced,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log: recordingInitLog(),
			prompts: { confirm: async () => true },
			signal: new AbortController().signal,
		})

		expect(seen[0]).toBe('{"apps":[]}')
		const final = parseProxyManifestJson(fixture.zerops.env('proxy').get(FABRIKA_PROXY_MANIFEST_JSON) ?? '')
		expect(final?.apps.map((app) => app.id)).toEqual(['iam', 'vozka', 'operations'])
	})

	test('a proxy that published no subdomain stops the install rather than composing a hostname', async () => {
		// The pre-deploy shape WU1 measured: one line, no `-<port>` segment. `derivePlatformHosts` refuses it.
		const zerops = fakeZerops({
			...PROJECT,
			projectMode: 'LIGHT',
			services: [],
			bootstrap: { clientId: CLIENT_ID, imported: importedLightServices() },
		})
		const noPorts = {
			...zerops.api,
			triggerPipeline: async (call: Parameters<typeof zerops.api.triggerPipeline>[0]) => {
				const process = await zerops.api.triggerPipeline(call)
				zerops.env('proxy').set('zeropsSubdomain', 'https://proxy-292c.prg1.zerops.app')
				return process
			},
		}

		await expect(
			runInstall(input(), {
				api: noPorts,
				reconcileSchema: async () => {},
				sleep: async () => {},
				log: recordingInitLog(),
				prompts: { confirm: async () => true },
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('publishes no Zerops subdomain')
	})
})

describe('the generated secrets', () => {
	test('each has the shape the service that reads it parses', () => {
		const secrets = generateInstallationSecrets()

		const signingKeys: unknown = JSON.parse(secrets.signingKeys)
		expect(Array.isArray(signingKeys)).toBe(true)
		const active = Array.isArray(signingKeys) ? signingKeys[0] : undefined
		expect(active).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
		// The private half: without `d` IAM can verify and never sign.
		expect(typeof (active as { d?: unknown }).d).toBe('string')
		expect(typeof (active as { kid?: unknown }).kid).toBe('string')

		for (const key of [secrets.rpcKey, secrets.proxyKey, secrets.provisioningKey]) {
			expect(key).toStartWith('px_')
			// 32 bytes at base64url is 43 characters; every shared secret must clear 32 or the service
			// refuses to boot.
			expect(key.slice(3)).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(key.length).toBeGreaterThanOrEqual(32)
		}
		for (const key of [secrets.operationsSyncKey, secrets.sourceRpcKey]) {
			expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
			expect(key.length).toBeGreaterThanOrEqual(32)
		}
		// base64, NOT base64url: the vault imports these bytes as an AES key.
		expect(secrets.vaultKey).toMatch(/^[A-Za-z0-9+/]{43}=$/)
		expect(Buffer.from(secrets.vaultKey, 'base64')).toHaveLength(32)
	})

	test('no base64url value starts with `-` or `_`, which downstream would read as a flag', () => {
		// One roll in sixteen starts with one of them, so a hundred rolls is the cheap version of a proof.
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const secrets = generateInstallationSecrets()
			for (
				const value of [
					secrets.rpcKey.slice(3),
					secrets.proxyKey.slice(3),
					secrets.provisioningKey.slice(3),
					secrets.operationsSyncKey,
					secrets.sourceRpcKey,
				]
			) {
				expect(value.startsWith('-') || value.startsWith('_')).toBe(false)
			}
		}
	})

	test('every value is fresh — nothing is reused between two installations', () => {
		const first = generateInstallationSecrets()
		const second = generateInstallationSecrets()
		expect(Object.values(first)).not.toEqual(Object.values(second))
	})
})

describe('what reaches which service', () => {
	test('a shared secret is the SAME value everywhere it is needed', async () => {
		const fixture = harness()

		await fixture.run()

		const iam = fixture.zerops.env('iam')
		const operations = fixture.zerops.env('operations')
		const control = fixture.zerops.env('control')
		const source = fixture.zerops.env('source')
		const proxy = fixture.zerops.env('proxy')

		// The RPC key: IAM serves it, control and Operations present it.
		expect(control.get('FABRIKA_IAM_RPC_KEY')).toBe(iam.get('FABRIKA_IAM_RPC_KEY'))
		expect(operations.get('FABRIKA_IAM_RPC_KEY')).toBe(iam.get('FABRIKA_IAM_RPC_KEY'))
		// The proxy key: IAM calls it `FABRIKA_IAM_PROXY_KEY`, the proxy `FABRIKA_IAM_KEY`, and control
		// hands the same value to every namespace proxy it provisions.
		expect(proxy.get('FABRIKA_IAM_KEY')).toBe(iam.get('FABRIKA_IAM_PROXY_KEY'))
		expect(control.get('FABRIKA_ZEROPS_PROXY_IAM_KEY')).toBe(iam.get('FABRIKA_IAM_PROXY_KEY'))
		// The provisioning key: IAM admits it, control and (later) the sidecar present it.
		expect(control.get('FABRIKA_IAM_PROVISIONING_KEY')).toBe(iam.get('FABRIKA_IAM_PROVISIONING_KEY'))
		// The catalog key: control projects with it, Operations checks it.
		expect(control.get('OPERATIONS_SYNC_KEY')).toBe(operations.get('OPERATIONS_SYNC_KEY'))
		expect(control.get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')).toBe(source.get('FABRIKA_SOURCE_RPC_KEY'))
		// And the two that belong to exactly one service.
		expect(iam.get('FABRIKA_IAM_SIGNING_KEYS')).toBeDefined()
		expect(control.get('FABRIKA_CONTROL_VAULT_KEY')).toBeDefined()
		expect(operations.has('FABRIKA_CONTROL_VAULT_KEY')).toBe(false)
		expect(source.has('FABRIKA_ZEROPS_ACCESS_TOKEN')).toBe(false)
	})

	test('the platform references, the derived origins and the switches password-only needs', async () => {
		const fixture = harness()

		await fixture.run()

		const dsn = '${db_connectionTlsString}/${db_dbName}?sslmode=require'
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_DATABASE_URL')).toBe(dsn)
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_DATABASE_URL')).toBe(dsn)
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_DATABASE_URL')).toBe(dsn)
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_BLOB_BUCKET')).toBe('${storage_bucketName}')
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_BLOB_ENDPOINT')).toBe('${storage_apiUrl}')
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_RUN_LOGS_ENDPOINT')).toBe('${storage_apiUrl}')

		expect(fixture.zerops.env('iam').get('ISSUER')).toBe(`https://${IAM_HOST}`)
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_ADMIN_ORIGINS')).toBe(JSON.stringify([`https://${CONSOLE_HOST}`]))
		// A bare host, not an origin.
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_DOMAIN')).toBe(CONSOLE_HOST)
		expect(fixture.zerops.env('control').get('OPERATIONS_ARTIFACT_ORIGIN')).toBe(`https://${OPERATIONS_HOST}`)
		expect(fixture.zerops.env('operations').get('FABRIKA_OPERATIONS_PUBLIC_HOST')).toBe(OPERATIONS_HOST)

		// Password only, by decision — and IAM's own defaults are the other way round.
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_OIDC_ENABLED')).toBe('false')
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_PASSWORD_ENABLED')).toBe('true')
		for (const hostname of PLATFORM_DEPLOY_ORDER.filter((hostname) => hostname !== 'source')) {
			expect(fixture.zerops.env(hostname).get('ENVIRONMENT')).toBe('stage')
		}
	})

	test('never a key the service declares in its own zerops.yaml — the env API refuses those', async () => {
		const fixture = harness()

		await fixture.run()

		// `putServiceEnv` answers `userDataDuplicateKey` on these and cannot resolve the conflict to a
		// record id, so writing one is an error rather than an overwrite.
		const declared = [
			'PORT',
			'FABRIKA_IAM_RPC_URL',
			'FABRIKA_OPERATIONS_URL',
			'FABRIKA_CONTROL_ASSETS_DIR',
			'FABRIKA_CONTROL_URL',
			'FABRIKA_PROXY_MANIFEST',
			'FABRIKA_PROXY_PORT',
		]
		const written = fixture.zerops.calls.filter((call) => call.startsWith('env:')).map((call) => call.split(':')[2])
		for (const key of declared) {
			expect(written).not.toContain(key)
		}
	})

	test('`GENERATED_SECRET_KEYS` names exactly the keys whose value is generated', () => {
		const secrets = generateInstallationSecrets()
		const matrix = installationServiceEnv({
			projectId: PROJECT.projectId,
			environment: 'stage',
			scheme: 'https',
			hosts: { iam: IAM_HOST, control: CONSOLE_HOST, operations: OPERATIONS_HOST },
			clientId: CLIENT_ID,
			buildFromGit: 'https://github.com/contember/fabrika-platform',
			secrets,
			zeropsAccessToken: 'minted',
		})
		const generated = new Set<string>([...Object.values(secrets), 'minted'])
		for (const hostname of PLATFORM_DEPLOY_ORDER) {
			const carrying = [...(matrix.get(hostname) ?? new Map<string, string>())]
				.filter(([, value]) => generated.has(value))
				.map(([key]) => key)
			expect([...carrying].sort()).toEqual([...(GENERATED_SECRET_KEYS.get(hostname) ?? [])].sort())
		}
	})

	test('the region API base reaches control only when the installation names one', () => {
		const withRegion = installationServiceEnv({
			projectId: PROJECT.projectId,
			environment: 'stage',
			scheme: 'https',
			hosts: { iam: IAM_HOST, control: CONSOLE_HOST, operations: OPERATIONS_HOST },
			clientId: CLIENT_ID,
			buildFromGit: 'https://github.com/contember/fabrika-platform',
			secrets: generateInstallationSecrets(),
			zeropsAccessToken: 'minted',
			apiBaseUrl: 'https://api.app-brn1.zerops.io/api/rest/public',
		})
		expect(withRegion.get('control')?.get('FABRIKA_ZEROPS_API_BASE_URL')).toBe('https://api.app-brn1.zerops.io/api/rest/public')
	})

	test('fresh installs are anonymous while project identity reaches control', () => {
		const matrix = installationServiceEnv({
			projectId: PROJECT.projectId,
			environment: 'stage',
			scheme: 'https',
			hosts: { iam: IAM_HOST, control: CONSOLE_HOST, operations: OPERATIONS_HOST },
			clientId: CLIENT_ID,
			buildFromGit: 'https://github.com/contember/fabrika-platform',
			secrets: generateInstallationSecrets(),
			zeropsAccessToken: 'minted',
		})
		expect(matrix.get('source')?.has('GITHUB_APP_CREDENTIALS')).toBe(false)
		expect(matrix.get('source')?.has('GITHUB_APP_ID')).toBe(false)
		expect(matrix.get('source')?.has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
		expect(matrix.get('source')?.has('GITHUB_WEBHOOK_SECRET')).toBe(false)
		expect(matrix.get('control')?.get('FABRIKA_ZEROPS_PROJECT_ID')).toBe(PROJECT.projectId)
		expect(matrix.get('control')?.has('GITHUB_WEBHOOK_SECRET')).toBe(false)
		expect(matrix.get('control')?.has('GITHUB_APP_PRIVATE_KEY')).toBe(false)
	})
})

describe('the hand-off', () => {
	test('deploys through `deployPlatform`, which finds every derived variable already correct', async () => {
		const fixture = harness()

		await fixture.run()

		// The ONLY thing pass 2 has left to write is the manifest it composes — every origin the deploy
		// derives was written from the same hosts one step earlier.
		const afterPassOne = fixture.zerops.calls.slice(fixture.zerops.calls.indexOf('deploy:proxy') + 1)
		const passTwoWrites = afterPassOne.slice(afterPassOne.findIndex((call) => call === 'deploy:iam') - 1)
		expect(passTwoWrites.filter((call) => call.startsWith('env:'))).toEqual([`env:proxy:${FABRIKA_PROXY_MANIFEST_JSON}`])

		expect(fixture.reconciled).toHaveLength(1)
		expect(fixture.reconciled[0]?.app).toBe('vozka')
		expect(fixture.reconciled[0]?.url).toBe(`https://${IAM_HOST}`)
		expect(fixture.reconciled[0]?.returnOrigins).toEqual([`https://${CONSOLE_HOST}`])
		// It authenticates with the key this command generated, which is what makes the hand-off work.
		expect(fixture.reconciled[0]?.adminKey).toBe(fixture.zerops.env('iam').get('FABRIKA_IAM_PROVISIONING_KEY'))
	})

	test('names the provisioning key ONCE and the two required deploy secrets `platform init` will ask for', async () => {
		const fixture = harness()

		await fixture.run()

		const provisioningKey = fixture.zerops.env('iam').get('FABRIKA_IAM_PROVISIONING_KEY') ?? 'none'
		const occurrences = fixture.log.lines.filter((line) => line.includes(provisioningKey))
		expect(occurrences).toHaveLength(1)
		expect(occurrences[0]).toStartWith('action: CAPTURE THIS NOW')
		const transcript = fixture.log.lines.join('\n')
		expect(transcript).toContain('FABRIKA_IAM_PROVISIONING_KEY')
		expect(transcript).toContain('FABRIKA_ZEROPS_ACCESS_TOKEN')
	})

	test('NO other secret value reaches the transcript — not one of them', async () => {
		const fixture = harness()

		await fixture.run()

		const transcript = fixture.log.lines.join('\n')
		const provisioningKey = fixture.zerops.env('iam').get('FABRIKA_IAM_PROVISIONING_KEY')
		for (const [where, value] of writtenSecrets(fixture.zerops)) {
			if (value === provisioningKey) {
				continue
			}
			expect(`${where} leaked: ${transcript.includes(value)}`).toEndWith('false')
		}
		expect(transcript).not.toContain(input().accessToken)
		for (const minted of fixture.zerops.mintedTokens) {
			expect(transcript).not.toContain(minted)
		}
	})
})

describe('what it refuses', () => {
	test('a project whose core package does not match the tier', async () => {
		const fixture = harness({ projectMode: 'SERIOUS' })

		await expect(fixture.run()).rejects.toThrow('is SERIOUS and the light tier needs LIGHT')
		expect(fixture.zerops.calls).toEqual([])
	})

	test('a mode Zerops did not state is a warning, not a refusal', async () => {
		const zerops = fakeZerops({
			...PROJECT,
			services: [],
			bootstrap: { clientId: CLIENT_ID, imported: importedLightServices() },
		})
		const log = recordingInitLog()

		await runInstall(input(), {
			api: zerops.api,
			reconcileSchema: async () => {},
			sleep: async () => {},
			log,
			prompts: { confirm: async () => true },
			signal: new AbortController().signal,
		})

		expect(log.lines.some((line) => line.startsWith('warn: ') && line.includes('mode'))).toBe(true)
		expect(zerops.calls).toContain('import:proj-1')
	})

	test('a project that already holds an installation, before it writes or imports anything', async () => {
		const fixture = harness({
			services: importedLightServices().map((service) =>
				service.name === 'control' ? { ...service, env: { FABRIKA_CONTROL_VAULT_KEY: 'the-existing-one' } } : service
			),
		})

		await expect(fixture.run()).rejects.toThrow('already holds an installation')
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.zerops.env('control').get('FABRIKA_CONTROL_VAULT_KEY')).toBe('the-existing-one')
	})

	test('a service the platform is still CREATING, without reading its empty environment first', async () => {
		// Live: a service reads `NEW` with zero environment keys until the platform finishes creating it,
		// ~15 s per runtime service. An earlier run holds the process ids; a later one does not, so this
		// refuses with what to do rather than sleeping on a number nobody promised.
		const fixture = harness({
			services: importedLightServices().map((service) => (service.name === 'proxy' ? { ...service, status: 'NEW' as const } : service)),
		})

		await expect(fixture.run()).rejects.toThrow('still creating proxy')
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.zerops.timeline.some((entry) => entry.startsWith('readenv:'))).toBe(false)
	})

	test('a PARTIAL set of services, rather than re-applying startWithoutCode over the live ones', async () => {
		const fixture = harness({ services: importedLightServices().filter((service) => service.name !== 'control') })

		await expect(fixture.run()).rejects.toThrow('but not control')
		expect(fixture.zerops.calls).toEqual([])
	})

	test('`local` as the installation name, before anything is contacted', async () => {
		const fixture = harness()

		await expect(fixture.run({ environment: 'local' })).rejects.toThrow('is refused')
		expect(fixture.zerops.calls).toEqual([])
		expect(fixture.asked).toEqual([])
	})

	test('a tier that has no services-only import document', () => {
		expect(() =>
			parsePlatformInstallArgs(['--project-id=p1', '--client-id=c1', '--env=stage', '--tier=standard'], {
				FABRIKA_ZEROPS_ACCESS_TOKEN: 'token',
			})
		).toThrow('cannot be installed into a project you created')
	})
})

describe('a project that already has the services', () => {
	test('skips the import, which would activate an EMPTY app version on each of them', async () => {
		const fixture = harness({ services: importedLightServices() })

		await fixture.run()

		expect(fixture.zerops.calls.filter((call) => call.startsWith('import:'))).toEqual([])
		expect(fixture.zerops.imports).toEqual([])
		// And it still brings the installation up: the services exist, they simply carry no secrets yet.
		expect(fixture.zerops.calls).toContain('deploy:control')
		expect(fixture.zerops.env('iam').get('FABRIKA_IAM_SIGNING_KEYS')).toBeDefined()
		expect(fixture.log.lines.some((line) => line.includes('skipping the import'))).toBe(true)
	})
})

describe('every outward step is confirmed', () => {
	test('in order, and each one gates what follows it', async () => {
		const fixture = harness()

		await fixture.run()

		expect(fixture.asked).toHaveLength(6)
		expect(fixture.asked[0]).toContain('Read Zerops project proj-1')
		expect(fixture.asked[1]).toContain('Import 7 services')
		expect(fixture.asked[2]).toContain('Mint an integration token')
		expect(fixture.asked[3]).toContain('build it from https://github.com/contember/fabrika-platform')
		expect(fixture.asked[4]).toContain('variables across 5 services')
		expect(fixture.asked[5]).toContain('Deploy the installation now')
	})

	test('declining the project read contacts nothing at all', async () => {
		const fixture = harness({
			confirms: { 'Read Zerops project proj-1 and its services? (the token, the id, the core package, what exists)': false },
		})

		await expect(fixture.run()).rejects.toThrow('declined')
		expect(fixture.zerops.calls).toEqual([])
	})

	test('declining the import creates nothing', async () => {
		const fixture = harness({
			confirms: { 'Import 7 services (db, storage, iam, operations, source, control, proxy) into project proj-1?': false },
		})

		await expect(fixture.run()).rejects.toThrow('nothing has been created')
		expect(fixture.zerops.calls).toEqual([])
	})

	test('declining the deploy leaves every variable placed and says what to run', async () => {
		const fixture = harness({ confirms: { 'Deploy the installation now? (about 15 minutes)': false } })

		await fixture.run()

		expect(fixture.zerops.calls.filter((call) => call.startsWith('deploy:'))).toEqual(['deploy:proxy'])
		expect(fixture.log.lines.join('\n')).toContain('fabrika platform deploy --provider=zerops --project-id=proj-1 --env=stage')
		// The hand-off still happens: the key exists whether or not the deploy ran.
		expect(fixture.log.lines.some((line) => line.startsWith('action: CAPTURE THIS NOW'))).toBe(true)
	})
})

describe('the argument surface', () => {
	test('reads flags first, then the environment, and refuses anything that could carry a credential', () => {
		expect(
			parsePlatformInstallArgs(['--project-id=p1', '--client-id=c1', '--env=stage'], {
				FABRIKA_ZEROPS_ACCESS_TOKEN: 'token',
			}),
		).toEqual({
			projectId: 'p1',
			clientId: 'c1',
			accessToken: 'token',
			environment: 'stage',
			scheme: 'https',
			buildFromGit: 'https://github.com/contember/fabrika-platform',
			tier: 'light',
		})
		expect(() => parsePlatformInstallArgs(['--token=nope'], {})).toThrow('unexpected argument')
		expect(() => parsePlatformInstallArgs([], { FABRIKA_ZEROPS_ACCESS_TOKEN: 'token' })).toThrow('FABRIKA_ZEROPS_PROJECT_ID is required')
		expect(() => parsePlatformInstallArgs(['--project-id=p1', '--client-id=c1', '--env=stage'], {})).toThrow(
			'FABRIKA_ZEROPS_ACCESS_TOKEN is required',
		)
	})

	test('ignores GitHub credential environment during anonymous fresh install', () => {
		const parsed = parsePlatformInstallArgs(['--project-id=p1', '--client-id=c1', '--env=stage'], {
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'token',
			GITHUB_APP_CREDENTIALS: 'must-not-be-consumed-by-install',
			GITHUB_WEBHOOK_SECRET: 'must-not-be-consumed-by-install',
		})
		expect(Object.keys(parsed)).not.toContain('githubAppCredentials')
	})
})

/** A type-level reminder that the deploy order is not this command's to restate. */
const _order: readonly PlatformDeployService[] = PLATFORM_DEPLOY_ORDER
